import type {
  AvailableAction,
  ClueView,
  PendingQuestionView,
  PublicTimelineEvent,
  RoomPlayerView,
  RoomView,
  ScriptSummary,
} from '@ai-murder-mystery/shared'
import { ScriptRepository } from '../script/repository.js'
import type { ScriptDefinition } from '../script/types.js'
import { RoomRepository } from './repository.js'
import { GameDirector } from '../round/director.js'

export class RoomQueryService {
  constructor(
    private readonly rooms:RoomRepository,
    private readonly scripts:ScriptRepository,
    private readonly director:GameDirector,
  ) {}

  listScripts():ScriptSummary[] {
    return this.scripts.list().map(script=>({
      id:script.id,
      version:script.version,
      title:script.title,
      description:script.description,
      playerCount:script.roles.length,
      publicContext:script.publicContext,
    }))
  }

  view(roomId:string,viewerPlayerId?:string|null):RoomView {
    const room=this.rooms.requireRoom(roomId)
    const script=this.requireScript(room.scriptVersionId)
    const players=this.rooms.listPlayers(roomId)
    const me=viewerPlayerId ? players.find(player=>player.id===viewerPlayerId) ?? null : null
    const round=this.rooms.getCurrentRound(roomId)
    const definition=round ? script.rounds[round.roundIndex] : undefined
    const roundStates=round?this.rooms.listRoundStates(round.id):[]
    const stateByPlayerId=new Map(roundStates.map(state=>[state.roomPlayerId,state]))
    const currentTurnId=round?.turnOrder[round.turnIndex]??null
    const votedIds=new Set(round&&definition?.type==='vote'
      ? this.rooms.listVotes(roomId,round.id).map(vote=>vote.roomPlayerId)
      : [])
    const playerViews=players.map(player=>{
      const state=stateByPlayerId.get(player.id)
      let roundStatus:RoomPlayerView['roundStatus']
      if(round&&definition&&state) {
        if(definition.type==='discussion') {
          if(definition.mode!=='free') {
            roundStatus=state.initialActionDone?'done':currentTurnId===player.id?'current':'waiting'
          } else if(state.discussionFinished) {
            roundStatus='done'
          } else if(state.activationCount===0) {
            roundStatus='waiting'
          } else {
            roundStatus='needs_confirmation'
          }
        } else if(definition.type==='search') {
          roundStatus=state.searchFinished?'search_done':'searching'
        } else if(definition.type==='vote') {
          roundStatus=votedIds.has(player.id)?'voted':'waiting'
        }
      }
      const canNudge=player.controller==='agent'
        && definition?.type==='discussion'
        && definition.mode==='free'
        && roundStatus==='needs_confirmation'
      return this.playerView(player,script,roundStatus,canNudge)
    })
    const events=this.rooms.listPublicEvents(roomId)
    const playerNames=new Map(playerViews.map(player=>[player.id,player.displayName]))
    const publicTimeline=events.map(event=>({
      id:event.id,
      seq:event.seq,
      type:event.type,
      actorPlayerId:event.actorPlayerId,
      actorName:event.actorPlayerId?playerNames.get(event.actorPlayerId)??null:null,
      targetPlayerId:event.targetPlayerId,
      targetName:event.targetPlayerId?playerNames.get(event.targetPlayerId)??null:null,
      payload:event.payload,
      createdAt:event.createdAt,
    } satisfies PublicTimelineEvent))

    const holdings=this.rooms.listHoldings(roomId)
    const publicHoldings=[...new Map(
      holdings.filter(holding=>holding.state==='public').map(holding=>[holding.clueId,holding] as const)
    ).values()]
    const publicClues=publicHoldings.map(holding=>this.clueView(holding,script))
    const privateClues=me
      ? holdings.filter(holding=>holding.roomPlayerId===me.id&&holding.state==='private').map(holding=>this.clueView(holding,script))
      : []

    const pending=this.rooms.listPendingQuestions(roomId)
    const pendingQuestionsForMe:PendingQuestionView[]=me ? pending.filter(question=>question.toPlayerId===me.id).map(question=>{
      const source=events.find(event=>event.id===question.sourceEventId)
      return {
        id:question.id,
        sourceEventId:question.sourceEventId,
        fromPlayerId:question.fromPlayerId,
        fromName:playerNames.get(question.fromPlayerId)??question.fromPlayerId,
        toPlayerId:question.toPlayerId,
        toName:playerNames.get(question.toPlayerId)??question.toPlayerId,
        question:String(source?.payload.content??''),
        status:question.status,
      }
    }) : []

    const publicRoles=script.roles.map(role=>{
      const selected=players.find(player=>player.roleId===role.id)
      return {
        id:role.id,
        name:role.name,
        age:role.age,
        gender:role.gender,
        occupation:role.occupation,
        publicProfile:role.publicProfile,
        ...(selected?{selectedByPlayerId:selected.id}:{}),
      }
    })

    const view:RoomView={
      id:room.id,
      script:{
        id:script.id,version:script.version,title:script.title,description:script.description,
        playerCount:script.roles.length,publicContext:script.publicContext,
      },
      status:room.status,
      sharedVersion:room.sharedVersion,
      players:playerViews,
      me:me?playerViews.find(player=>player.id===me.id)??null:null,
      currentRound:round&&definition?{
        id:round.id,
        definitionId:round.roundDefinitionId,
        title:definition.title,
        type:round.type,
        ...(definition.type==='discussion'?{mode:definition.mode}:{}),
        ...(definition.type==='discussion'&&definition.requiredAction?{requiredAction:definition.requiredAction}:{}),
        index:round.roundIndex,
        status:round.status,
        sharedVersionAtStart:round.publicVersionAtStart,
        ...(definition.type==='search'?{actionsPerPlayer:definition.actionsPerPlayer}:{}),
      }:null,
      availableActions:me?this.availableActions(roomId,me.id):[],
      publicTimeline,
      publicClues,
      privateClues,
      pendingQuestionsForMe,
      locations:script.locations.map(location=>({...location})),
      publicRoles,
      roundPlan:script.rounds.map((item,index)=>({
        id:item.id,title:item.title,
        type:item.type,
        ...(item.type==='discussion'?{mode:item.mode}:{}),
        index,
      })),
    }

    if(room.status==='lobby') {
      view.roleCards=publicRoles
    }

    if(me?.roleId) {
      const role=script.roles.find(item=>item.id===me.roleId)
      if(role) view.privateRole={
        roleId:role.id,name:role.name,privateStory:role.privateStory,knownFacts:role.knownFacts,
        secrets:role.secrets,goals:role.goals,relationships:role.relationships,
      }
    }

    if(room.status==='completed') {
      const murderer=script.roles.find(role=>role.id===script.truth.murdererRoleId)
      const voteRound=this.findVoteRound(roomId)
      const votes=voteRound ? this.rooms.listVotes(roomId,voteRound.id) : []
      view.result={
        murdererRoleId:script.truth.murdererRoleId,
        murdererName:murderer?.name??script.truth.murdererRoleId,
        truth:script.truth.content,
        votes:votes.map(vote=>{
          const player=players.find(item=>item.id===vote.roomPlayerId)
          const target=script.roles.find(role=>role.id===vote.targetRoleId)
          return {
            playerId:vote.roomPlayerId,
            playerName:playerNames.get(vote.roomPlayerId)??vote.roomPlayerId,
            targetRoleId:vote.targetRoleId,
            targetName:target?.name??vote.targetRoleId,
          }
        }),
      }
      view.review={
        roles:script.roles.map(role=>({
          roleId:role.id,
          name:role.name,
          age:role.age,
          gender:role.gender,
          occupation:role.occupation,
          publicProfile:role.publicProfile,
          privateStory:role.privateStory,
          knownFacts:role.knownFacts,
          secrets:role.secrets,
          goals:role.goals,
          relationships:role.relationships,
        })),
        clues:script.clues.map(clue=>{
          const clueHoldings=holdings.filter(item=>item.clueId===clue.id)
          const holding=clueHoldings.find(item=>item.state==='public')??clueHoldings[0]
          const owner=holding?players.find(player=>player.id===holding.roomPlayerId):undefined
          return {
            clueId:clue.id,
            title:clue.title,
            content:clue.content,
            locationId:clue.locationId,
            status:clueHoldings.some(item=>item.state==='public')
              ? 'public'
              : clueHoldings.length
                ? 'kept_private'
                : 'undiscovered',
            ownerPlayerId:holding?.roomPlayerId??null,
            ownerName:holding?playerNames.get(holding.roomPlayerId)??null:null,
          }
        }),
      }
    }

    return view
  }

  private availableActions(roomId:string,playerId:string):AvailableAction[] {
    const room=this.rooms.requireRoom(roomId)
    if(room.status==='lobby') {
      const player=this.rooms.requirePlayer(roomId,playerId)
      return player.controller==='human' ? ['SELECT_ROLE','START_GAME'] : []
    }
    if(room.status==='completed'||room.status==='aborted') return []
    const round=this.rooms.getCurrentRound(roomId)
    if(!round) return []
    const definition=this.director.definition(roomId)
    const player=this.rooms.requirePlayer(roomId,playerId)
    const state=this.rooms.requireRoundState(round.id,playerId)
    const actions:AvailableAction[]=[]

    if(definition.type==='discussion') {
      const orderedAllowed=definition.mode==='free'||this.director.isOrderedTurn(roomId,playerId)
      if(orderedAllowed) {
        if(definition.allowedTools.includes('send_message')) actions.push('SEND_MESSAGE')
        if(definition.allowedTools.includes('ask_player')) actions.push('ASK_PLAYER')
        if(definition.allowedTools.includes('finish_round')) actions.push('FINISH_ROUND')
        if(this.rooms.listPendingQuestions(roomId).some(question=>question.toPlayerId===playerId)) {
          if(definition.allowedTools.includes('reply_question')) actions.push('REPLY_QUESTION')
          if(definition.allowedTools.includes('decline_question')) actions.push('DECLINE_QUESTION')
        }
      }
      if(definition.mode!=='ordered'&&state.discussionFinished) {
        return []
      }
      return actions
    }

    if(definition.type==='search') {
      if(!state.searchFinished&&state.searchActionsUsed<definition.actionsPerPlayer) actions.push('SEARCH_CLUE')
      if(!state.searchFinished) actions.push('FINISH_SEARCH')
      if(this.rooms.listHoldings(roomId).some(holding=>holding.roomPlayerId===playerId&&holding.state==='private')) {
        actions.push('REVEAL_CLUE','KEEP_CLUE_PRIVATE')
      }
      return actions
    }

    if(definition.type==='vote') {
      const voted=this.rooms.listVotes(roomId,round.id).some(vote=>vote.roomPlayerId===playerId)
      return voted?[]:['SUBMIT_VOTE']
    }

    return player.controller==='human'?[]:[]
  }

  private playerView(
    player:ReturnType<RoomRepository['requirePlayer']>,
    script:ScriptDefinition,
    roundStatus?:RoomPlayerView['roundStatus'],
    canNudge=false,
  ):RoomPlayerView {
    const role=player.roleId?script.roles.find(item=>item.id===player.roleId):undefined
    return {
      id:player.id,seatNo:player.seatNo,roleId:player.roleId,roleName:role?.name??null,
      controller:player.controller,displayName:role?.name??player.displayName,status:player.status,
      ...(roundStatus?{roundStatus}:{}),
      ...(canNudge?{canNudge:true}:{}),
    }
  }

  private clueView(holding:ReturnType<RoomRepository['requireHolding']>,script:ScriptDefinition):ClueView {
    const clue=script.clues.find(item=>item.id===holding.clueId)
    if(!clue) throw new Error('CLUE_DEFINITION_NOT_FOUND')
    return {
      holdingId:holding.id,clueId:clue.id,title:clue.title,content:clue.content,
      locationId:clue.locationId,ownerPlayerId:holding.roomPlayerId,state:holding.state,
    }
  }

  private requireScript(versionId:string) {
    const script=this.scripts.getByVersionId(versionId)
    if(!script) throw new Error('SCRIPT_VERSION_NOT_FOUND')
    return script
  }

  private findVoteRound(roomId:string) {
    const row=this.rooms.database.db.prepare("select * from round_instances where room_id=? and type='vote' order by round_index desc limit 1")
      .get(roomId) as Record<string,unknown>|undefined
    return row?this.rooms.getRound(String(row.id)):null
  }
}
