import { randomUUID } from 'node:crypto'
import type { GameToolName } from '@ai-murder-mystery/shared'
import { GameDirector } from '../round/director.js'
import { ScriptRepository } from '../script/repository.js'
import type { ClueDefinition, RoundDefinition } from '../script/types.js'
import { RoomRepository } from './repository.js'

type CommandResult = Record<string,unknown>

export class RoomCommandService {
  constructor(
    private readonly rooms:RoomRepository,
    private readonly scripts:ScriptRepository,
    private readonly director:GameDirector,
  ) {}

  createRoom(scriptId:string,humanCount=1) {
    const script=this.scripts.getById(scriptId)
    if(!script) throw new Error('SCRIPT_NOT_FOUND')
    if(!Number.isInteger(humanCount)||humanCount<1||humanCount>script.roles.length) throw new Error('INVALID_HUMAN_COUNT')
    return this.rooms.database.transaction(()=>{
      const room=this.rooms.createRoom(this.scripts.versionId(script),'murder-mystery-v2')
      for(let index=0;index<humanCount;index+=1) {
        this.rooms.addPlayer({
          roomId:room.id,seatNo:index+1,controller:'human',displayName:`玩家${index+1}`,
        })
      }
      return this.rooms.requireRoom(room.id)
    })
  }

  selectRole(roomId:string,playerId:string,roleId:string) {
    return this.rooms.database.transaction(()=>{
      const room=this.rooms.requireRoom(roomId)
      if(room.status!=='lobby') throw new Error('ROLE_SELECTION_CLOSED')
      const player=this.rooms.requirePlayer(roomId,playerId)
      if(player.controller!=='human') throw new Error('ONLY_HUMAN_SELECTS_ROLE')
      const script=this.requireScript(roomId)
      const role=script.roles.find(item=>item.id===roleId)
      if(!role) throw new Error('ROLE_NOT_FOUND')
      if(this.rooms.listPlayers(roomId).some(other=>other.id!==playerId&&other.roleId===roleId)) throw new Error('ROLE_ALREADY_SELECTED')
      this.rooms.setPlayerRole(roomId,playerId,roleId,role.name)
      return this.rooms.requirePlayer(roomId,playerId)
    })
  }

  startRoom(roomId:string) {
    const result=this.rooms.database.transaction(()=>{
      const room=this.rooms.requireRoom(roomId)
      if(room.status!=='lobby') throw new Error('ROOM_ALREADY_STARTED')
      const script=this.requireScript(roomId)
      const humans=this.rooms.listPlayers(roomId)
      if(humans.some(player=>!player.roleId)) throw new Error('ALL_HUMANS_MUST_SELECT_ROLE')
      const selected=new Set(humans.map(player=>player.roleId))
      const remaining=script.roles.filter(role=>!selected.has(role.id))
      remaining.forEach((role,index)=>this.rooms.addPlayer({
        roomId,
        seatNo:humans.length+index+1,
        controller:'agent',
        displayName:role.name,
        roleId:role.id,
      }))
      this.rooms.updateRoomStatus(roomId,'running')
      this.rooms.appendEvent({
        roomId,
        type:'room_started',
        visibility:'public',
        payload:{scriptId:script.id,scriptVersion:script.version},
      })
      return this.rooms.requireRoom(roomId)
    })
    this.director.startFirstRound(roomId)
    return result
  }

  sendMessage(roomId:string,playerId:string,commandId:string,content:string) {
    return this.run(roomId,playerId,commandId,'send_message',()=>{
      this.assertTool(roomId,playerId,'send_message')
      const text=content.trim()
      if(!text) throw new Error('MESSAGE_EMPTY')
      this.assertNotExactDuplicate(roomId,playerId,text)
      const round=this.requireRound(roomId)
      const event=this.rooms.appendEvent({
        roomId,roundInstanceId:round.id,actorPlayerId:playerId,
        type:'message_sent',visibility:'public',payload:{content:text},
      })
      this.markActivity(roomId,playerId)
      return {eventId:event.id,seq:event.seq}
    })
  }

  askPlayer(roomId:string,playerId:string,commandId:string,targetPlayerId:string,question:string) {
    return this.run(roomId,playerId,commandId,'ask_player',()=>{
      this.assertTool(roomId,playerId,'ask_player')
      this.rooms.requirePlayer(roomId,targetPlayerId)
      if(targetPlayerId===playerId) throw new Error('CANNOT_ASK_SELF')
      const content=question.trim()
      if(!content) throw new Error('QUESTION_EMPTY')
      const round=this.requireRound(roomId)
      const event=this.rooms.appendEvent({
        roomId,roundInstanceId:round.id,actorPlayerId:playerId,targetPlayerId,
        type:'question_asked',visibility:'public',payload:{content},
      })
      const interaction=this.rooms.createQuestion({
        roomId,roundInstanceId:round.id,fromPlayerId:playerId,toPlayerId:targetPlayerId,sourceEventId:event.id,
      })
      this.markActivity(roomId,playerId)
      return {eventId:event.id,questionId:interaction.id}
    })
  }

  replyQuestion(roomId:string,playerId:string,commandId:string,questionId:string,content:string) {
    return this.run(roomId,playerId,commandId,'reply_question',()=>{
      this.assertTool(roomId,playerId,'reply_question')
      const question=this.rooms.requireQuestion(roomId,questionId)
      if(question.status!=='pending'||question.toPlayerId!==playerId) throw new Error('QUESTION_NOT_PENDING_FOR_PLAYER')
      const text=content.trim()
      if(!text) throw new Error('REPLY_EMPTY')
      const round=this.requireRound(roomId)
      const event=this.rooms.appendEvent({
        roomId,roundInstanceId:round.id,actorPlayerId:playerId,targetPlayerId:question.fromPlayerId,
        type:'question_replied',visibility:'public',payload:{questionId,content:text},
      })
      this.rooms.resolveQuestion(roomId,questionId,'answered',event.id)
      this.markActivity(roomId,playerId)
      return {eventId:event.id,questionId}
    })
  }

  declineQuestion(roomId:string,playerId:string,commandId:string,questionId:string) {
    return this.run(roomId,playerId,commandId,'decline_question',()=>{
      this.assertTool(roomId,playerId,'decline_question')
      const question=this.rooms.requireQuestion(roomId,questionId)
      if(question.status!=='pending'||question.toPlayerId!==playerId) throw new Error('QUESTION_NOT_PENDING_FOR_PLAYER')
      this.rooms.resolveQuestion(roomId,questionId,'declined',null)
      this.markSeen(roomId,playerId)
      return {questionId,declined:true}
    })
  }

  yieldTurn(roomId:string,playerId:string,commandId:string) {
    return this.run(roomId,playerId,commandId,'yield_turn',()=>{
      this.assertTool(roomId,playerId,'yield_turn')
      const round=this.requireRound(roomId)
      const state=this.rooms.requireRoundState(round.id,playerId)
      this.rooms.updateRoundState(round.id,playerId,{
        lastSeenPublicVersion:this.rooms.requireRoom(roomId).sharedVersion,
        activationCount:state.activationCount+1,
      })
      this.director.markInitialAction(roomId,playerId)
      return {yielded:true}
    })
  }

  finishRound(roomId:string,playerId:string,commandId:string) {
    return this.run(roomId,playerId,commandId,'finish_round',()=>{
      this.assertTool(roomId,playerId,'finish_round')
      const round=this.requireRound(roomId)
      for(const question of this.rooms.listPendingQuestions(roomId)) {
        if(question.toPlayerId===playerId) this.rooms.resolveQuestion(roomId,question.id,'declined',null)
      }
      const sharedVersion=this.rooms.requireRoom(roomId).sharedVersion
      const state=this.rooms.requireRoundState(round.id,playerId)
      this.rooms.updateRoundState(round.id,playerId,{
        lastSeenPublicVersion:sharedVersion,
        doneAtPublicVersion:sharedVersion,
        activationCount:state.activationCount+1,
        initialActionDone:true,
      })
      this.director.markInitialAction(roomId,playerId)
      const event=this.rooms.appendEvent({
        roomId,roundInstanceId:round.id,actorPlayerId:playerId,
        type:'round_finished',visibility:'control',ownerPlayerId:playerId,payload:{sharedVersion},
      })
      return {eventId:event.id,sharedVersion}
    })
  }

  searchClue(roomId:string,playerId:string,commandId:string,locationId:string) {
    return this.run(roomId,playerId,commandId,'search_clue',()=>{
      this.assertTool(roomId,playerId,'search_clue')
      const round=this.requireRound(roomId)
      const definition=this.director.definition(roomId)
      if(definition.type!=='search') throw new Error('NOT_SEARCH_ROUND')
      const state=this.rooms.requireRoundState(round.id,playerId)
      if(state.searchFinished||state.searchActionsUsed>=definition.actionsPerPlayer) throw new Error('SEARCH_QUOTA_EXHAUSTED')
      const script=this.requireScript(roomId)
      if(!script.locations.some(location=>location.id===locationId)) throw new Error('LOCATION_NOT_FOUND')
      const holdings=this.rooms.listHoldings(roomId)
      const ownedByPlayer=new Set(
        holdings.filter(holding=>holding.roomPlayerId===playerId).map(holding=>holding.clueId)
      )
      const candidates=script.clues.filter(clue=>
        clue.roundId===definition.id && clue.locationId===locationId && !ownedByPlayer.has(clue.id)
      )
      if(!candidates.length) throw new Error('NO_CLUE_AT_LOCATION')
      const clue=this.pickClue(candidates,roomId,playerId,state.searchActionsUsed)
      const acquired=this.rooms.appendEvent({
        roomId,roundInstanceId:round.id,actorPlayerId:playerId,ownerPlayerId:playerId,
        type:'clue_acquired',visibility:'private',
        payload:{clueId:clue.id,title:clue.title,content:clue.content,locationId:clue.locationId},
      })
      const forced=clue.revealPolicy==='forced_public'
      const alreadyPublic=holdings.find(holding=>holding.clueId===clue.id&&holding.state==='public')
      const holding=this.rooms.addHolding({
        roomId,playerId,clueId:clue.id,acquiredEventId:acquired.id,state:forced||alreadyPublic?'public':'private',
      })
      let revealEventId:string|null=alreadyPublic?.revealedEventId??null
      if(forced&&!alreadyPublic) {
        const revealed=this.rooms.appendEvent({
          roomId,roundInstanceId:round.id,actorPlayerId:playerId,
          type:'clue_revealed',visibility:'public',
          payload:{holdingId:holding.id,clueId:clue.id,title:clue.title,content:clue.content,locationId:clue.locationId},
        })
        this.rooms.revealHolding(roomId,holding.id,revealed.id)
        revealEventId=revealed.id
      }
      this.rooms.updateRoundState(round.id,playerId,{
        searchActionsUsed:state.searchActionsUsed+1,
        lastSeenPublicVersion:this.rooms.requireRoom(roomId).sharedVersion,
      })
      return {
        holdingId:holding.id,
        clueId:clue.id,
        title:clue.title,
        content:clue.content,
        locationId:clue.locationId,
        revealPolicy:clue.revealPolicy,
        forcedPublic:forced,
        revealEventId,
      }
    })
  }

  revealClue(roomId:string,playerId:string,commandId:string,holdingId:string) {
    return this.run(roomId,playerId,commandId,'reveal_clue',()=>{
      this.assertTool(roomId,playerId,'reveal_clue')
      const holding=this.rooms.requireHolding(roomId,holdingId)
      if(holding.roomPlayerId!==playerId) throw new Error('CLUE_NOT_OWNED_BY_PLAYER')
      if(holding.state==='public') return {holdingId,alreadyPublic:true}
      const alreadyPublic=this.rooms.listHoldings(roomId).find(item=>
        item.id!==holding.id&&item.clueId===holding.clueId&&item.state==='public'
      )
      if(alreadyPublic) {
        this.rooms.revealHolding(roomId,holding.id,alreadyPublic.revealedEventId??alreadyPublic.acquiredEventId)
        return {holdingId,eventId:alreadyPublic.revealedEventId,alreadyPublic:true}
      }
      const script=this.requireScript(roomId)
      const clue=script.clues.find(item=>item.id===holding.clueId)
      if(!clue) throw new Error('CLUE_DEFINITION_NOT_FOUND')
      const round=this.requireRound(roomId)
      const event=this.rooms.appendEvent({
        roomId,roundInstanceId:round.id,actorPlayerId:playerId,
        type:'clue_revealed',visibility:'public',
        payload:{holdingId,clueId:clue.id,title:clue.title,content:clue.content,locationId:clue.locationId},
      })
      this.rooms.revealHolding(roomId,holdingId,event.id)
      return {holdingId,eventId:event.id}
    })
  }

  keepCluePrivate(roomId:string,playerId:string,commandId:string,holdingId:string) {
    return this.run(roomId,playerId,commandId,'keep_clue_private',()=>{
      this.assertTool(roomId,playerId,'keep_clue_private')
      const holding=this.rooms.requireHolding(roomId,holdingId)
      if(holding.roomPlayerId!==playerId) throw new Error('CLUE_NOT_OWNED_BY_PLAYER')
      return {holdingId,state:holding.state}
    })
  }

  finishSearch(roomId:string,playerId:string,commandId:string) {
    return this.run(roomId,playerId,commandId,'finish_search',()=>{
      this.assertTool(roomId,playerId,'finish_search')
      const round=this.requireRound(roomId)
      this.rooms.updateRoundState(round.id,playerId,{searchFinished:true})
      return {finished:true}
    })
  }

  submitVote(roomId:string,playerId:string,commandId:string,targetRoleId:string,reasoning?:string) {
    return this.run(roomId,playerId,commandId,'submit_vote',()=>{
      this.assertTool(roomId,playerId,'submit_vote')
      const script=this.requireScript(roomId)
      if(!script.roles.some(role=>role.id===targetRoleId)) throw new Error('VOTE_TARGET_NOT_FOUND')
      const round=this.requireRound(roomId)
      this.rooms.upsertVote({
        roomId,roundInstanceId:round.id,roomPlayerId:playerId,targetRoleId,
        reasoning:reasoning?.trim()||null,submittedAt:new Date().toISOString(),
      })
      const event=this.rooms.appendEvent({
        roomId,roundInstanceId:round.id,actorPlayerId:playerId,ownerPlayerId:playerId,
        type:'vote_submitted',visibility:'sealed',payload:{targetRoleId},
      })
      return {eventId:event.id,submitted:true}
    })
  }

  private run<T extends CommandResult>(
    roomId:string,
    playerId:string,
    commandId:string,
    commandType:string,
    fn:()=>T,
  ):T {
    const existing=this.rooms.getReceipt<T>(roomId,commandId)
    if(existing) {
      this.director.reconcile(roomId)
      return existing
    }
    const result=this.rooms.database.transaction(()=>{
      this.rooms.requirePlayer(roomId,playerId)
      const inside=this.rooms.getReceipt<T>(roomId,commandId)
      if(inside) return inside
      const value=fn()
      this.rooms.saveReceipt(roomId,commandId,playerId,commandType,value)
      return value
    })
    this.director.reconcile(roomId)
    return result
  }

  private assertTool(roomId:string,playerId:string,tool:GameToolName) {
    const room=this.rooms.requireRoom(roomId)
    if(room.status!=='running'&&room.status!=='voting') throw new Error('ROOM_NOT_RUNNING')
    const definition=this.director.definition(roomId)
    if(!definition.allowedTools.includes(tool as never)) throw new Error('TOOL_NOT_ALLOWED_IN_ROUND')
    if(definition.type==='discussion'&&definition.mode!=='free'&&!this.director.isOrderedTurn(roomId,playerId)) {
      throw new Error('NOT_ORDERED_TURN')
    }
  }

  private markSeen(roomId:string,playerId:string) {
    const round=this.requireRound(roomId)
    const state=this.rooms.requireRoundState(round.id,playerId)
    this.rooms.updateRoundState(round.id,playerId,{
      lastSeenPublicVersion:this.rooms.requireRoom(roomId).sharedVersion,
      activationCount:state.activationCount+1,
    })
  }

  private markActivity(roomId:string,playerId:string) {
    const round=this.requireRound(roomId)
    const state=this.rooms.requireRoundState(round.id,playerId)
    this.rooms.updateRoundState(round.id,playerId,{
      lastSeenPublicVersion:this.rooms.requireRoom(roomId).sharedVersion,
      activationCount:state.activationCount+1,
      doneAtPublicVersion:null,
    })
    const definition=this.director.definition(roomId)
    if(definition.type==='discussion'&&definition.mode!=='free') {
      this.director.markInitialAction(roomId,playerId)
    }
  }

  private assertNotExactDuplicate(roomId:string,playerId:string,content:string) {
    const round=this.requireRound(roomId)
    const last=[...this.rooms.listPublicEvents(roomId)].reverse().find(event=>
      event.roundInstanceId===round.id
      && event.actorPlayerId===playerId
      && event.type==='message_sent'
    )
    if(last&&last.payload.content===content) throw new Error('DUPLICATE_MESSAGE')
  }

  private requireRound(roomId:string) {
    const round=this.rooms.getCurrentRound(roomId)
    if(!round) throw new Error('NO_ACTIVE_ROUND')
    return round
  }

  private requireScript(roomId:string) {
    const room=this.rooms.requireRoom(roomId)
    const script=this.scripts.getByVersionId(room.scriptVersionId)
    if(!script) throw new Error('SCRIPT_VERSION_NOT_FOUND')
    return script
  }

  private pickClue(candidates:ClueDefinition[],roomId:string,playerId:string,used:number) {
    let seed=2166136261
    for(const char of `${roomId}:${playerId}:${used}`) seed=((seed^char.charCodeAt(0))*16777619)>>>0
    return candidates[seed%candidates.length]!
  }
}
