import type { RoundDefinition, ScriptDefinition } from '../script/types.js'
import { ScriptRepository } from '../script/repository.js'
import { RoomRepository } from '../room/repository.js'

export function shuffledTurnOrder<T>(items:T[],random:()=>number=Math.random):T[] {
  const result=[...items]
  for(let index=result.length-1;index>0;index-=1) {
    const swapIndex=Math.floor(random()*(index+1))
    const current=result[index]!
    result[index]=result[swapIndex]!
    result[swapIndex]=current
  }
  return result
}

export class GameDirector {
  constructor(
    private readonly rooms: RoomRepository,
    private readonly scripts: ScriptRepository,
  ) {}

  startFirstRound(roomId:string) {
    const room=this.rooms.requireRoom(roomId)
    const script=this.requireScript(room.scriptVersionId)
    if (!script.rounds.length) throw new Error('SCRIPT_HAS_NO_ROUNDS')
    return this.startRound(roomId,script,0)
  }

  reconcile(roomId:string): { advanced:boolean; completed:boolean } {
    const room=this.rooms.requireRoom(roomId)
    const round=this.rooms.getCurrentRound(roomId)
    if (!round) return {advanced:false,completed:room.status==='completed'}
    const script=this.requireScript(room.scriptVersionId)
    const definition=script.rounds[round.roundIndex]
    if (!definition || definition.id!==round.roundDefinitionId) throw new Error('ROUND_DEFINITION_MISMATCH')
    if (!this.isRoundComplete(roomId,definition)) return {advanced:false,completed:false}

    this.rooms.database.transaction(()=>{
      const current=this.rooms.requireRoom(roomId)
      const active=this.rooms.getCurrentRound(roomId)
      if (!active || active.id!==round.id || active.status!=='active') return
      this.rooms.completeRound(active.id)
      this.rooms.appendEvent({
        roomId,
        roundInstanceId:active.id,
        type:'round_completed',
        visibility:'public',
        payload:{roundDefinitionId:definition.id,roundIndex:active.roundIndex},
      })
    })

    const nextIndex=round.roundIndex+1
    if (nextIndex>=script.rounds.length) {
      this.completeGame(roomId,script)
      return {advanced:true,completed:true}
    }

    const next=script.rounds[nextIndex]!
    if (next.type==='reveal') {
      this.startRound(roomId,script,nextIndex)
      this.completeGame(roomId,script)
      return {advanced:true,completed:true}
    }

    this.startRound(roomId,script,nextIndex)
    return {advanced:true,completed:false}
  }

  definition(roomId:string):RoundDefinition {
    const room=this.rooms.requireRoom(roomId)
    const round=this.rooms.getCurrentRound(roomId)
    if(!round) throw new Error('NO_ACTIVE_ROUND')
    const script=this.requireScript(room.scriptVersionId)
    const definition=script.rounds[round.roundIndex]
    if(!definition||definition.id!==round.roundDefinitionId) throw new Error('ROUND_DEFINITION_MISMATCH')
    return definition
  }

  isOrderedTurn(roomId:string,playerId:string):boolean {
    const round=this.rooms.getCurrentRound(roomId)
    if(!round) return false
    const definition=this.definition(roomId)
    if(definition.type!=='discussion'||definition.mode==='free') return true
    if(definition.mode==='ordered_opportunity_then_free'&&round.turnIndex>=round.turnOrder.length) return true
    return round.turnOrder[round.turnIndex]===playerId
  }

  markInitialAction(roomId:string,playerId:string) {
    const round=this.rooms.getCurrentRound(roomId)
    if(!round) throw new Error('NO_ACTIVE_ROUND')
    const definition=this.definition(roomId)
    if(definition.type!=='discussion') return
    const state=this.rooms.requireRoundState(round.id,playerId)
    if(!state.initialActionDone) this.rooms.updateRoundState(round.id,playerId,{initialActionDone:true})
    if(definition.mode!=='free' && round.turnOrder[round.turnIndex]===playerId) {
      this.rooms.setRoundTurnIndex(round.id,round.turnIndex+1)
    }
  }

  private isRoundComplete(roomId:string,definition:RoundDefinition):boolean {
    const room=this.rooms.requireRoom(roomId)
    const round=this.rooms.getCurrentRound(roomId)
    if(!round) return false
    const players=this.rooms.listPlayers(roomId)
    const states=this.rooms.listRoundStates(round.id)
    if(states.length!==players.length) return false

    if(definition.type==='discussion') {
      if(definition.mode==='ordered') return states.every(state=>state.initialActionDone)
      const pending=this.rooms.listPendingQuestions(roomId)
      return pending.length===0 && states.every(state=>
        state.doneAtPublicVersion!==null && state.doneAtPublicVersion>=room.sharedVersion
      )
    }

    if(definition.type==='search') {
      return states.every(state=>state.searchFinished)
    }

    if(definition.type==='vote') {
      return this.rooms.listVotes(roomId,round.id).length===players.length
    }

    return true
  }

  private startRound(roomId:string,script:ScriptDefinition,roundIndex:number) {
    return this.rooms.database.transaction(()=>{
      const room=this.rooms.requireRoom(roomId)
      const definition=script.rounds[roundIndex]
      if(!definition) throw new Error('ROUND_DEFINITION_NOT_FOUND')
      const players=this.rooms.listPlayers(roomId)
      const ordered=definition.type==='discussion' && definition.mode!=='free'
      const seatOrder=players.map(player=>player.id)
      const turnOrder=ordered
        ? definition.id==='introduction'
          ? shuffledTurnOrder(seatOrder)
          : seatOrder
        : []
      const round=this.rooms.createRound({
        roomId,
        definitionId:definition.id,
        roundIndex,
        type:definition.type,
        publicVersionAtStart:room.sharedVersion,
        turnOrder,
      })
      this.rooms.setCurrentRound(roomId,round.id)
      this.rooms.appendEvent({
        roomId,
        roundInstanceId:round.id,
        type:'round_started',
        visibility:'public',
        payload:{
          roundDefinitionId:definition.id,
          roundIndex,
          roundType:definition.type,
          mode:definition.type==='discussion'?definition.mode:undefined,
        },
      })
      const shared=this.rooms.requireRoom(roomId).sharedVersion
      this.rooms.createRoundStates(round.id,players.map(player=>player.id),shared)
      if(definition.type==='vote') this.rooms.updateRoomStatus(roomId,'voting')
      return this.rooms.requireRound(round.id)
    })
  }

  private completeGame(roomId:string,script:ScriptDefinition) {
    this.rooms.database.transaction(()=>{
      const room=this.rooms.requireRoom(roomId)
      if(room.status==='completed') return
      this.rooms.updateRoomStatus(roomId,'completed')
      this.rooms.appendEvent({
        roomId,
        roundInstanceId:room.currentRoundInstanceId,
        type:'game_completed',
        visibility:'public',
        payload:{murdererRoleId:script.truth.murdererRoleId},
      })
    })
  }

  private requireScript(versionId:string):ScriptDefinition {
    const script=this.scripts.getByVersionId(versionId)
    if(!script) throw new Error('SCRIPT_VERSION_NOT_FOUND')
    return script
  }
}
