import { GameDirector } from '../../domain/round/director.js'
import { RoomRepository } from '../../domain/room/repository.js'
import type { PlayerAgentRuntime } from '../player-agent/runtime.js'
import type { AgentTrigger } from '../player-agent/trigger.js'

export class RoomScheduler {
  private readonly running=new Set<string>()
  private readonly nudges=new Map<string,Set<string>>()

  constructor(
    private readonly rooms:RoomRepository,
    private readonly director:GameDirector,
    private readonly runtime:PlayerAgentRuntime,
  ) {}

  kick(roomId:string) {
    if(this.running.has(roomId)) return
    setImmediate(()=>{
      void this.pump(roomId).catch(error=>console.error('[murder-mystery scheduler]',roomId,error))
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
    if(state.doneAtPublicVersion!==null&&state.doneAtPublicVersion>=room.sharedVersion) {
      throw new Error('PLAYER_ALREADY_FINISHED_ROUND')
    }
    if(state.activationCount===0) throw new Error('PLAYER_HAS_NOT_ACTED_YET')

    const queue=this.nudges.get(roomId)??new Set<string>()
    queue.add(targetPlayerId)
    this.nudges.set(roomId,queue)
    return {queued:true,targetPlayerId}
  }

  resumeActiveRooms() {
    for(const roomId of this.rooms.listActiveRoomIds()) this.kick(roomId)
  }

  async pump(roomId:string,maxActivations=80):Promise<{activations:number;blockedByHuman:boolean;idle:boolean}> {
    if(this.running.has(roomId)) return {activations:0,blockedByHuman:false,idle:true}
    this.running.add(roomId)
    let activations=0
    try {
      await this.runtime.ensureRoomSessions(roomId)
      for(;activations<maxActivations;activations+=1) {
        this.director.reconcile(roomId)
        const room=this.rooms.requireRoom(roomId)
        if(room.status==='completed'||room.status==='aborted') {
          return {activations,blockedByHuman:false,idle:true}
        }
        const selected=this.nextTrigger(roomId)
        if(!selected.trigger) {
          return {activations,blockedByHuman:selected.blockedByHuman,idle:!selected.blockedByHuman}
        }
        await this.runtime.run(selected.trigger)
      }
      return {activations,blockedByHuman:false,idle:false}
    } finally {
      this.running.delete(roomId)
      if((this.nudges.get(roomId)?.size??0)>0) this.kick(roomId)
    }
  }

  nextTrigger(roomId:string):{trigger:AgentTrigger|null;blockedByHuman:boolean} {
    const room=this.rooms.requireRoom(roomId)
    const round=this.rooms.getCurrentRound(roomId)
    if(!round) return {trigger:null,blockedByHuman:false}
    const definition=this.director.definition(roomId)
    const players=this.rooms.listPlayers(roomId)
    const states=this.rooms.listRoundStates(round.id)
    const byId=new Map(players.map(player=>[player.id,player]))
    const stateById=new Map(states.map(state=>[state.roomPlayerId,state]))

    const nudged=this.takeNudge(roomId,room.sharedVersion,byId,stateById)
    if(nudged) {
      return {
        trigger:{type:'nudge',roomId,playerId:nudged,directedToYou:false},
        blockedByHuman:false,
      }
    }

    const pending=this.rooms.listPendingQuestions(roomId)
    for(const question of pending) {
      const target=byId.get(question.toPlayerId)
      const state=stateById.get(question.toPlayerId)
      if(target?.controller==='agent'&&state&&state.lastSeenPublicVersion<room.sharedVersion) {
        return {
          trigger:{
            type:'direct_question',
            roomId,
            playerId:target.id,
            sourceEventId:question.sourceEventId,
            fromPlayerId:question.fromPlayerId,
            questionId:question.id,
            directedToYou:true,
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
        if(state&&state.activationCount===0) {
          return {
            trigger:{type:'round_started',roomId,playerId:player.id,directedToYou:false},
            blockedByHuman:false,
          }
        }
      }

      for(const player of players) {
        if(player.controller!=='agent') continue
        const state=stateById.get(player.id)
        if(!state||state.activationCount===0) continue
        if(state.lastSeenPublicVersion<room.sharedVersion) {
          return {
            trigger:{type:'public_state_changed',roomId,playerId:player.id,directedToYou:false},
            blockedByHuman:false,
          }
        }
      }

      const humanNeedsAction=players.some(player=>{
        if(player.controller!=='human') return false
        const state=stateById.get(player.id)
        return !state || state.doneAtPublicVersion===null || state.doneAtPublicVersion<room.sharedVersion
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

  private takeNudge(
    roomId:string,
    sharedVersion:number,
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
      if(state.doneAtPublicVersion!==null&&state.doneAtPublicVersion>=sharedVersion) continue
      if(queue.size===0) this.nudges.delete(roomId)
      return playerId
    }
    this.nudges.delete(roomId)
    return null
  }
}
