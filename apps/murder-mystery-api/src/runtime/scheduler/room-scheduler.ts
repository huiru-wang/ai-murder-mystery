import { GameDirector } from '../../domain/round/director.js'
import { RoomRepository } from '../../domain/room/repository.js'
import type { PlayerAgentRuntime } from '../player-agent/runtime.js'
import type { MurderMysterySchedulerConfig } from '../../infra/config/ai.js'
import type { AgentTrigger, DiscussionPacing } from '../player-agent/trigger.js'

const DEFAULT_SCHEDULER_CONFIG:MurderMysterySchedulerConfig={
  discussionPacingAfterMinutes:8,
  discussionPacingMessageCount:30,
  discussionPacingActivationCount:45,
}

export class RoomScheduler {
  private readonly running=new Set<string>()
  private readonly nudges=new Map<string,Set<string>>()
  private readonly pacingTimers=new Map<string,ReturnType<typeof setTimeout>>()
  private readonly removedRooms=new Set<string>()

  constructor(
    private readonly rooms:RoomRepository,
    private readonly director:GameDirector,
    private readonly runtime:PlayerAgentRuntime,
    private readonly config:MurderMysterySchedulerConfig=DEFAULT_SCHEDULER_CONFIG,
  ) {}

  kick(roomId:string) {
    if(this.removedRooms.has(roomId)||this.running.has(roomId)) return
    setImmediate(()=>{
      void this.pump(roomId).catch(error=>{
        if(!this.removedRooms.has(roomId)) console.error('[murder-mystery scheduler]',roomId,error)
      })
    })
  }

  nudge(roomId:string,targetPlayerId:string) {
    const room=this.rooms.requireRoom(roomId)
    const round=this.rooms.getCurrentRound(roomId)
    if(!round) throw new Error('NO_ACTIVE_ROUND')
    const definition=this.director.definition(roomId)
    if(definition.type!=='discussion'||definition.mode!=='free') throw new Error('NUDGE_NOT_ALLOWED_IN_ROUND')
    const player=this.rooms.requirePlayer(roomId,targetPlayerId)
    if(player.controller!=='agent') throw new Error('NUDGE_REQUIRES_AI_PLAYER')
    const state=this.rooms.requireRoundState(round.id,targetPlayerId)
    if(state.discussionFinished) throw new Error('PLAYER_ALREADY_FINISHED_ROUND')
    if(state.activationCount===0) throw new Error('PLAYER_HAS_NOT_ACTED_YET')

    const queue=this.nudges.get(roomId)??new Set<string>()
    queue.add(targetPlayerId)
    this.nudges.set(roomId,queue)
    return {queued:true,targetPlayerId}
  }

  resumeActiveRooms() {
    for(const roomId of this.rooms.listActiveRoomIds()) this.kick(roomId)
  }

  async removeRoom(roomId:string) {
    this.rooms.requireRoom(roomId)
    this.removedRooms.add(roomId)
    this.nudges.delete(roomId)
    this.clearPacingTimer(roomId)
    await this.runtime.abortRoom(roomId)
    this.rooms.deleteRoom(roomId)
  }

  async pump(roomId:string,maxActivations=80):Promise<{activations:number;blockedByHuman:boolean;idle:boolean}> {
    if(this.removedRooms.has(roomId)||this.running.has(roomId)) return {activations:0,blockedByHuman:false,idle:true}
    this.running.add(roomId)
    let activations=0
    try {
      await this.runtime.ensureRoomSessions(roomId)
      for(;activations<maxActivations;activations+=1) {
        if(this.removedRooms.has(roomId)) return {activations,blockedByHuman:false,idle:true}
        this.director.reconcile(roomId)
        const room=this.rooms.requireRoom(roomId)
        if(room.status==='completed'||room.status==='aborted') {
          this.clearPacingTimer(roomId)
          return {activations,blockedByHuman:false,idle:true}
        }
        this.ensureDiscussionPacing(roomId)
        const selected=this.nextTrigger(roomId)
        if(!selected.trigger) {
          return {activations,blockedByHuman:selected.blockedByHuman,idle:!selected.blockedByHuman}
        }
        await this.runtime.run(selected.trigger)
      }
      return {activations,blockedByHuman:false,idle:false}
    } finally {
      this.running.delete(roomId)
      if(!this.removedRooms.has(roomId)&&(this.nudges.get(roomId)?.size??0)>0) this.kick(roomId)
    }
  }

  nextTrigger(roomId:string):{trigger:AgentTrigger|null;blockedByHuman:boolean} {
    const room=this.rooms.requireRoom(roomId)
    const round=this.rooms.getCurrentRound(roomId)
    if(!round) return {trigger:null,blockedByHuman:false}
    const definition=this.director.definition(roomId)
    const pacing=definition.type==='discussion'&&definition.mode==='free'
      ? this.discussionPacing(roomId)
      : undefined
    const players=this.rooms.listPlayers(roomId)
    const states=this.rooms.listRoundStates(round.id)
    const byId=new Map(players.map(player=>[player.id,player]))
    const stateById=new Map(states.map(state=>[state.roomPlayerId,state]))

    const nudged=this.takeNudge(roomId,byId,stateById)
    if(nudged) {
      return {
        trigger:{type:'nudge',roomId,playerId:nudged,directedToYou:false,pacing},
        blockedByHuman:false,
      }
    }

    const pending=this.rooms.listPendingQuestions(roomId)
    for(const question of pending) {
      const target=byId.get(question.toPlayerId)
      const state=stateById.get(question.toPlayerId)
      if(target?.controller==='agent'&&state&&!state.discussionFinished&&state.lastSeenPublicVersion<room.sharedVersion) {
        return {
          trigger:{
            type:'direct_question',
            roomId,
            playerId:target.id,
            sourceEventId:question.sourceEventId,
            fromPlayerId:question.fromPlayerId,
            questionId:question.id,
            directedToYou:true,
            pacing,
          },
          blockedByHuman:false,
        }
      }
    }

    if(definition.type==='discussion') {
      const orderedPhase=definition.mode==='ordered'
        || (definition.mode==='ordered_opportunity_then_free'&&round.turnIndex<round.turnOrder.length)
      if(orderedPhase) {
        const currentId=round.turnOrder[round.turnIndex]
        if(!currentId) return {trigger:null,blockedByHuman:false}
        const player=byId.get(currentId)
        if(!player) throw new Error('ORDERED_PLAYER_NOT_FOUND')
        if(player.controller==='human') return {trigger:null,blockedByHuman:true}
        return {
          trigger:{type:'scheduled_opportunity',roomId,playerId:player.id,directedToYou:false},
          blockedByHuman:false,
        }
      }

      for(const player of players) {
        if(player.controller!=='agent') continue
        const state=stateById.get(player.id)
        if(state&&!state.discussionFinished&&state.activationCount===0) {
          return {
            trigger:{type:'round_started',roomId,playerId:player.id,directedToYou:false,pacing},
            blockedByHuman:false,
          }
        }
      }

      for(const player of players) {
        if(player.controller!=='agent') continue
        const state=stateById.get(player.id)
        if(!state||state.discussionFinished||state.activationCount===0) continue
        if(state.lastSeenPublicVersion<room.sharedVersion) {
          return {
            trigger:{type:'public_state_changed',roomId,playerId:player.id,directedToYou:false,pacing},
            blockedByHuman:false,
          }
        }
      }

      const humanNeedsAction=players.some(player=>{
        if(player.controller!=='human') return false
        const state=stateById.get(player.id)
        return !state || !state.discussionFinished
      })
      return {trigger:null,blockedByHuman:humanNeedsAction}
    }

    if(definition.type==='search') {
      for(const player of players) {
        const state=stateById.get(player.id)
        if(!state||state.searchFinished||player.controller!=='agent') continue
        return {
          trigger:{type:'search_turn',roomId,playerId:player.id,directedToYou:false},
          blockedByHuman:false,
        }
      }
      const blocked=players.some(player=>player.controller==='human'&&!stateById.get(player.id)?.searchFinished)
      return {trigger:null,blockedByHuman:blocked}
    }

    if(definition.type==='vote') {
      const votes=this.rooms.listVotes(roomId,round.id)
      const voted=new Set(votes.map(vote=>vote.roomPlayerId))
      for(const player of players) {
        if(player.controller==='agent'&&!voted.has(player.id)) {
          return {
            trigger:{type:'vote_requested',roomId,playerId:player.id,directedToYou:false},
            blockedByHuman:false,
          }
        }
      }
      return {trigger:null,blockedByHuman:players.some(player=>player.controller==='human'&&!voted.has(player.id))}
    }

    return {trigger:null,blockedByHuman:false}
  }

  private discussionPacing(roomId:string):DiscussionPacing|undefined {
    const round=this.rooms.getCurrentRound(roomId)
    if(!round) return undefined
    const definition=this.director.definition(roomId)
    if(definition.type!=='discussion'||definition.mode!=='free') return undefined
    const elapsedMs=Math.max(0,Date.now()-Date.parse(round.startedAt))
    const publicMessageCount=this.rooms.listPublicEvents(roomId).filter(event=>
      event.roundInstanceId===round.id && ['message_sent','question_asked','question_replied','clue_revealed'].includes(event.type)
    ).length
    const states=this.rooms.listRoundStates(round.id)
    const activationCount=states.reduce((sum,state)=>sum+state.activationCount,0)
    const finishedPlayerCount=states.filter(state=>state.discussionFinished).length
    const shouldWrap=elapsedMs>=this.config.discussionPacingAfterMinutes*60_000
      || publicMessageCount>=this.config.discussionPacingMessageCount
      || activationCount>=this.config.discussionPacingActivationCount
    if(!shouldWrap) return undefined
    return {
      level:'should_wrap_up',
      elapsedMinutes:Math.max(1,Math.floor(elapsedMs/60_000)),
      publicMessageCount,
      activationCount,
      finishedPlayerCount,
      totalPlayerCount:states.length,
    }
  }

  private ensureDiscussionPacing(roomId:string) {
    const round=this.rooms.getCurrentRound(roomId)
    if(!round) {
      this.clearPacingTimer(roomId)
      return
    }
    const definition=this.director.definition(roomId)
    if(definition.type!=='discussion'||definition.mode!=='free') {
      this.clearPacingTimer(roomId)
      return
    }
    const alreadyReminded=this.rooms.listPublicEvents(roomId).some(event=>
      event.roundInstanceId===round.id && event.type==='discussion_pacing_reminder'
    )
    if(alreadyReminded) {
      this.clearPacingTimer(roomId)
      return
    }
    const pacing=this.discussionPacing(roomId)
    if(!pacing) {
      if(!this.pacingTimers.has(roomId)) {
        const elapsedMs=Math.max(0,Date.now()-Date.parse(round.startedAt))
        const delay=Math.max(1000,this.config.discussionPacingAfterMinutes*60_000-elapsedMs)
        const timer=setTimeout(()=>{
          this.pacingTimers.delete(roomId)
          this.kick(roomId)
        },delay)
        timer.unref?.()
        this.pacingTimers.set(roomId,timer)
      }
      return
    }
    this.clearPacingTimer(roomId)
    this.rooms.appendEvent({
      roomId,
      roundInstanceId:round.id,
      type:'discussion_pacing_reminder',
      visibility:'public',
      payload:{
        ...pacing,
        content:'本轮讨论已持续较长时间。请优先收敛已有观点；如果没有新的关键事实、矛盾或必须追问的问题，可以考虑结束本轮。',
      },
    })
  }

  private clearPacingTimer(roomId:string) {
    const timer=this.pacingTimers.get(roomId)
    if(timer) clearTimeout(timer)
    this.pacingTimers.delete(roomId)
  }

  private takeNudge(
    roomId:string,
    players:Map<string,ReturnType<RoomRepository['requirePlayer']>>,
    states:Map<string,ReturnType<RoomRepository['requireRoundState']>>,
  ):string|null {
    const queue=this.nudges.get(roomId)
    if(!queue?.size) return null
    for(const playerId of queue) {
      queue.delete(playerId)
      const player=players.get(playerId)
      const state=states.get(playerId)
      if(!player||player.controller!=='agent'||!state) continue
      if(state.discussionFinished) continue
      if(queue.size===0) this.nudges.delete(roomId)
      return playerId
    }
    this.nudges.delete(roomId)
    return null
  }
}
