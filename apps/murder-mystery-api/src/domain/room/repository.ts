import { randomUUID } from 'node:crypto'
import type { EventVisibility, RoomEventType, RoomStatus } from '@ai-murder-mystery/shared'
import type {
  ClueHoldingRecord,
  PendingInteractionRecord,
  PlayerRoundStateRecord,
  RoomEventRecord,
  RoomPlayerRecord,
  RoomRecord,
  RoundInstanceRecord,
  VoteRecord,
} from '../script/types.js'
import { MurderMysteryDatabase } from '../../infra/sqlite/database.js'

const json = <T>(value: string): T => JSON.parse(value) as T
const now = () => new Date().toISOString()

type Row = Record<string, unknown>

export class RoomRepository {
  constructor(readonly database: MurderMysteryDatabase) {}

  createRoom(scriptVersionId: string, runtimeRevision: string): RoomRecord {
    const id = randomUUID()
    const createdAt = now()
    this.database.db.prepare(`
      insert into rooms
      (id,script_version_id,status,current_round_instance_id,shared_version,last_event_seq,runtime_revision,created_at,updated_at)
      values (?,?,'lobby',null,0,0,?,?,?)
    `).run(id, scriptVersionId, runtimeRevision, createdAt, createdAt)
    return this.requireRoom(id)
  }

  getRoom(id: string): RoomRecord | null {
    const row = this.database.db.prepare('select * from rooms where id=?').get(id) as Row | undefined
    return row ? this.mapRoom(row) : null
  }

  requireRoom(id: string): RoomRecord {
    const room = this.getRoom(id)
    if (!room) throw new Error('ROOM_NOT_FOUND')
    return room
  }

  listActiveRoomIds(): string[] {
    const rows=this.database.db.prepare("select id from rooms where status in ('running','voting') order by updated_at")
      .all() as Array<{id:string}>
    return rows.map(row=>row.id)
  }

  updateRoomStatus(roomId: string, status: RoomStatus) {
    this.database.db.prepare('update rooms set status=?,updated_at=? where id=?').run(status, now(), roomId)
  }

  setCurrentRound(roomId: string, roundInstanceId: string | null) {
    this.database.db.prepare('update rooms set current_round_instance_id=?,updated_at=? where id=?')
      .run(roundInstanceId, now(), roomId)
  }

  addPlayer(input: {
    roomId: string
    seatNo: number
    controller: 'human' | 'agent'
    displayName: string
    roleId?: string | null
    userId?: string | null
  }): RoomPlayerRecord {
    const id = randomUUID()
    const createdAt = now()
    this.database.db.prepare(`
      insert into room_players
      (id,room_id,seat_no,role_id,controller,display_name,user_id,agent_session_id,status,created_at)
      values (?,?,?,?,?,?,?,null,'active',?)
    `).run(
      id,
      input.roomId,
      input.seatNo,
      input.roleId ?? null,
      input.controller,
      input.displayName,
      input.userId ?? null,
      createdAt,
    )
    return this.requirePlayer(input.roomId, id)
  }

  listPlayers(roomId: string): RoomPlayerRecord[] {
    const rows = this.database.db.prepare('select * from room_players where room_id=? order by seat_no').all(roomId) as Row[]
    return rows.map(row => this.mapPlayer(row))
  }

  getPlayer(roomId: string, playerId: string): RoomPlayerRecord | null {
    const row = this.database.db.prepare('select * from room_players where room_id=? and id=?').get(roomId, playerId) as Row | undefined
    return row ? this.mapPlayer(row) : null
  }

  requirePlayer(roomId: string, playerId: string): RoomPlayerRecord {
    const player = this.getPlayer(roomId, playerId)
    if (!player) throw new Error('PLAYER_NOT_FOUND')
    return player
  }

  setPlayerRole(roomId: string, playerId: string, roleId: string, displayName?: string) {
    if(displayName) {
      this.database.db.prepare('update room_players set role_id=?,display_name=? where room_id=? and id=?')
        .run(roleId, displayName, roomId, playerId)
      return
    }
    this.database.db.prepare('update room_players set role_id=? where room_id=? and id=?').run(roleId, roomId, playerId)
  }

  setPlayerAgentSession(roomId: string, playerId: string, sessionId: string) {
    this.database.db.prepare('update room_players set agent_session_id=? where room_id=? and id=?').run(sessionId, roomId, playerId)
  }

  createRound(input: {
    roomId: string
    definitionId: string
    roundIndex: number
    type: RoundInstanceRecord['type']
    publicVersionAtStart: number
    turnOrder?: string[]
  }): RoundInstanceRecord {
    const id = randomUUID()
    const startedAt = now()
    this.database.db.prepare(`
      insert into round_instances
      (id,room_id,round_definition_id,round_index,type,status,public_version_at_start,turn_order_json,turn_index,started_at,completed_at)
      values (?,?,?,?,?,'active',?,?,0,?,null)
    `).run(
      id,
      input.roomId,
      input.definitionId,
      input.roundIndex,
      input.type,
      input.publicVersionAtStart,
      JSON.stringify(input.turnOrder ?? []),
      startedAt,
    )
    return this.requireRound(id)
  }

  getRound(id: string): RoundInstanceRecord | null {
    const row = this.database.db.prepare('select * from round_instances where id=?').get(id) as Row | undefined
    return row ? this.mapRound(row) : null
  }

  requireRound(id: string): RoundInstanceRecord {
    const round = this.getRound(id)
    if (!round) throw new Error('ROUND_NOT_FOUND')
    return round
  }

  getCurrentRound(roomId: string): RoundInstanceRecord | null {
    const room = this.requireRoom(roomId)
    return room.currentRoundInstanceId ? this.getRound(room.currentRoundInstanceId) : null
  }

  completeRound(roundId: string) {
    this.database.db.prepare("update round_instances set status='completed',completed_at=? where id=?").run(now(), roundId)
  }

  setRoundTurnIndex(roundId: string, turnIndex: number) {
    this.database.db.prepare('update round_instances set turn_index=? where id=?').run(turnIndex, roundId)
  }

  createRoundStates(roundId: string, playerIds: string[], sharedVersion: number) {
    const insert = this.database.db.prepare(`
      insert into player_round_states
      (round_instance_id,room_player_id,last_seen_public_version,done_at_public_version,activation_count,initial_action_done,search_actions_used,search_finished,updated_at)
      values (?,?,?,null,0,0,0,0,?)
    `)
    const createdAt = now()
    for (const playerId of playerIds) insert.run(roundId, playerId, sharedVersion, createdAt)
  }

  listRoundStates(roundId: string): PlayerRoundStateRecord[] {
    const rows = this.database.db.prepare('select * from player_round_states where round_instance_id=?').all(roundId) as Row[]
    return rows.map(row => this.mapRoundState(row))
  }

  requireRoundState(roundId: string, playerId: string): PlayerRoundStateRecord {
    const row = this.database.db.prepare('select * from player_round_states where round_instance_id=? and room_player_id=?')
      .get(roundId, playerId) as Row | undefined
    if (!row) throw new Error('PLAYER_ROUND_STATE_NOT_FOUND')
    return this.mapRoundState(row)
  }

  updateRoundState(roundId: string, playerId: string, patch: Partial<{
    lastSeenPublicVersion:number
    doneAtPublicVersion:number|null
    activationCount:number
    initialActionDone:boolean
    searchActionsUsed:number
    searchFinished:boolean
  }>) {
    const current = this.requireRoundState(roundId, playerId)
    const next = { ...current, ...patch, updatedAt: now() }
    this.database.db.prepare(`
      update player_round_states set
        last_seen_public_version=?,
        done_at_public_version=?,
        activation_count=?,
        initial_action_done=?,
        search_actions_used=?,
        search_finished=?,
        updated_at=?
      where round_instance_id=? and room_player_id=?
    `).run(
      next.lastSeenPublicVersion,
      next.doneAtPublicVersion,
      next.activationCount,
      next.initialActionDone ? 1 : 0,
      next.searchActionsUsed,
      next.searchFinished ? 1 : 0,
      next.updatedAt,
      roundId,
      playerId,
    )
  }

  appendEvent(input: {
    roomId: string
    roundInstanceId?: string | null
    actorPlayerId?: string | null
    type: RoomEventType
    visibility: EventVisibility
    ownerPlayerId?: string | null
    targetPlayerId?: string | null
    payload?: Record<string, unknown>
  }): RoomEventRecord {
    const room = this.requireRoom(input.roomId)
    const seq = room.lastEventSeq + 1
    const id = randomUUID()
    const createdAt = now()
    this.database.db.prepare(`
      insert into room_events
      (id,room_id,round_instance_id,seq,actor_player_id,event_type,visibility,owner_player_id,target_player_id,payload_json,created_at)
      values (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      input.roomId,
      input.roundInstanceId ?? null,
      seq,
      input.actorPlayerId ?? null,
      input.type,
      input.visibility,
      input.ownerPlayerId ?? null,
      input.targetPlayerId ?? null,
      JSON.stringify(input.payload ?? {}),
      createdAt,
    )
    const sharedDelta = input.visibility === 'public' ? 1 : 0
    this.database.db.prepare(`
      update rooms
      set last_event_seq=?,shared_version=shared_version+?,updated_at=?
      where id=?
    `).run(seq, sharedDelta, createdAt, input.roomId)
    return {
      id,
      roomId:input.roomId,
      roundInstanceId:input.roundInstanceId ?? null,
      seq,
      actorPlayerId:input.actorPlayerId ?? null,
      type:input.type,
      visibility:input.visibility,
      ownerPlayerId:input.ownerPlayerId ?? null,
      targetPlayerId:input.targetPlayerId ?? null,
      payload:input.payload ?? {},
      createdAt,
    }
  }

  listEvents(roomId: string): RoomEventRecord[] {
    const rows = this.database.db.prepare('select * from room_events where room_id=? order by seq').all(roomId) as Row[]
    return rows.map(row => this.mapEvent(row))
  }

  listPublicEvents(roomId: string): RoomEventRecord[] {
    const rows = this.database.db.prepare("select * from room_events where room_id=? and visibility='public' order by seq")
      .all(roomId) as Row[]
    return rows.map(row => this.mapEvent(row))
  }

  listVisibleEvents(roomId: string, playerId: string): RoomEventRecord[] {
    const rows = this.database.db.prepare(`
      select * from room_events
      where room_id=?
        and (
          visibility='public'
          or (visibility='private' and owner_player_id=?)
          or (visibility='control' and actor_player_id=?)
        )
      order by seq
    `).all(roomId, playerId, playerId) as Row[]
    return rows.map(row => this.mapEvent(row))
  }

  addHolding(input: {
    roomId:string
    playerId:string
    clueId:string
    acquiredEventId:string
    state:'private'|'public'
  }): ClueHoldingRecord {
    const id = randomUUID()
    const createdAt = now()
    this.database.db.prepare(`
      insert into clue_holdings
      (id,room_id,room_player_id,clue_id,acquired_event_id,state,revealed_event_id,created_at)
      values (?,?,?,?,?,?,null,?)
    `).run(id,input.roomId,input.playerId,input.clueId,input.acquiredEventId,input.state,createdAt)
    return this.requireHolding(input.roomId,id)
  }

  requireHolding(roomId:string,holdingId:string):ClueHoldingRecord {
    const row=this.database.db.prepare('select * from clue_holdings where room_id=? and id=?').get(roomId,holdingId) as Row|undefined
    if(!row) throw new Error('CLUE_HOLDING_NOT_FOUND')
    return this.mapHolding(row)
  }

  listHoldings(roomId:string):ClueHoldingRecord[] {
    const rows=this.database.db.prepare('select * from clue_holdings where room_id=? order by created_at').all(roomId) as Row[]
    return rows.map(row=>this.mapHolding(row))
  }

  revealHolding(roomId:string,holdingId:string,eventId:string) {
    this.database.db.prepare("update clue_holdings set state='public',revealed_event_id=? where room_id=? and id=?")
      .run(eventId,roomId,holdingId)
  }

  createQuestion(input:{
    roomId:string
    roundInstanceId:string
    fromPlayerId:string
    toPlayerId:string
    sourceEventId:string
  }):PendingInteractionRecord {
    const id=randomUUID()
    const createdAt=now()
    this.database.db.prepare(`
      insert into pending_interactions
      (id,room_id,round_instance_id,interaction_type,from_player_id,to_player_id,source_event_id,status,resolved_event_id,created_at,resolved_at)
      values (?,?,?,'question',?,?,?,'pending',null,?,null)
    `).run(id,input.roomId,input.roundInstanceId,input.fromPlayerId,input.toPlayerId,input.sourceEventId,createdAt)
    return this.requireQuestion(input.roomId,id)
  }

  requireQuestion(roomId:string,id:string):PendingInteractionRecord {
    const row=this.database.db.prepare('select * from pending_interactions where room_id=? and id=?').get(roomId,id) as Row|undefined
    if(!row) throw new Error('QUESTION_NOT_FOUND')
    return this.mapQuestion(row)
  }

  listPendingQuestions(roomId:string):PendingInteractionRecord[] {
    const rows=this.database.db.prepare("select * from pending_interactions where room_id=? and status='pending' order by created_at")
      .all(roomId) as Row[]
    return rows.map(row=>this.mapQuestion(row))
  }

  resolveQuestion(roomId:string,id:string,status:'answered'|'declined',eventId:string|null) {
    this.database.db.prepare(`
      update pending_interactions set status=?,resolved_event_id=?,resolved_at=? where room_id=? and id=?
    `).run(status,eventId,now(),roomId,id)
  }

  upsertVote(vote: VoteRecord) {
    this.database.db.prepare(`
      insert into votes (room_id,round_instance_id,room_player_id,target_role_id,reasoning,submitted_at)
      values (?,?,?,?,?,?)
      on conflict(round_instance_id,room_player_id) do update set
        target_role_id=excluded.target_role_id,
        reasoning=excluded.reasoning,
        submitted_at=excluded.submitted_at
    `).run(vote.roomId,vote.roundInstanceId,vote.roomPlayerId,vote.targetRoleId,vote.reasoning,vote.submittedAt)
  }

  listVotes(roomId:string,roundInstanceId:string):VoteRecord[] {
    const rows=this.database.db.prepare('select * from votes where room_id=? and round_instance_id=?')
      .all(roomId,roundInstanceId) as Row[]
    return rows.map(row=>({
      roomId:String(row.room_id),
      roundInstanceId:String(row.round_instance_id),
      roomPlayerId:String(row.room_player_id),
      targetRoleId:String(row.target_role_id),
      reasoning:row.reasoning===null?null:String(row.reasoning),
      submittedAt:String(row.submitted_at),
    }))
  }

  getReceipt<T>(roomId:string,commandId:string):T|null {
    const row=this.database.db.prepare('select result_json from command_receipts where room_id=? and command_id=?')
      .get(roomId,commandId) as {result_json:string}|undefined
    return row ? json<T>(row.result_json) : null
  }

  saveReceipt(roomId:string,commandId:string,actorPlayerId:string|null,commandType:string,result:unknown) {
    this.database.db.prepare(`
      insert into command_receipts (room_id,command_id,actor_player_id,command_type,result_json,created_at)
      values (?,?,?,?,?,?)
    `).run(roomId,commandId,actorPlayerId,commandType,JSON.stringify(result),now())
  }

  createAgentSessionBinding(input:{
    roomId:string
    playerId:string
    runtimeSessionId:string
    agentRevision:string
  }) {
    const id=randomUUID()
    this.database.db.prepare(`
      insert into agent_sessions
      (id,room_id,room_player_id,runtime_session_id,agent_revision,last_run_at,status)
      values (?,?,?,?,?,null,'active')
    `).run(id,input.roomId,input.playerId,input.runtimeSessionId,input.agentRevision)
    this.setPlayerAgentSession(input.roomId,input.playerId,input.runtimeSessionId)
    return id
  }

  getAgentSessionBinding(roomId:string,playerId:string): {id:string;runtimeSessionId:string;agentRevision:string}|null {
    const row=this.database.db.prepare('select id,runtime_session_id,agent_revision from agent_sessions where room_id=? and room_player_id=?')
      .get(roomId,playerId) as Row|undefined
    return row ? {id:String(row.id),runtimeSessionId:String(row.runtime_session_id),agentRevision:String(row.agent_revision)} : null
  }

  replaceAgentSessionBinding(input:{
    bindingId:string
    roomId:string
    playerId:string
    runtimeSessionId:string
    agentRevision:string
  }) {
    this.database.db.prepare(`
      update agent_sessions
      set runtime_session_id=?,agent_revision=?,last_run_at=null,status='active'
      where id=? and room_id=? and room_player_id=?
    `).run(input.runtimeSessionId,input.agentRevision,input.bindingId,input.roomId,input.playerId)
    this.setPlayerAgentSession(input.roomId,input.playerId,input.runtimeSessionId)
  }

  touchAgentSession(bindingId:string) {
    this.database.db.prepare('update agent_sessions set last_run_at=? where id=?').run(now(),bindingId)
  }

  createAgentRun(input:{
    agentSessionId:string
    roundInstanceId:string|null
    triggerType:string
    triggerEventId:string|null
  }):string {
    const id=randomUUID()
    this.database.db.prepare(`
      insert into agent_runs
      (id,agent_session_id,round_instance_id,trigger_type,trigger_event_id,started_at,completed_at,status,tool_count,token_usage_json)
      values (?,?,?,?,?, ?,null,'running',0,null)
    `).run(id,input.agentSessionId,input.roundInstanceId,input.triggerType,input.triggerEventId,now())
    return id
  }

  completeAgentRun(runId:string,status:'completed'|'failed',toolCount:number) {
    this.database.db.prepare('update agent_runs set status=?,completed_at=?,tool_count=? where id=?')
      .run(status,now(),toolCount,runId)
  }

  private mapRoom(row:Row):RoomRecord {
    return {
      id:String(row.id),
      scriptVersionId:String(row.script_version_id),
      status:String(row.status) as RoomRecord['status'],
      currentRoundInstanceId:row.current_round_instance_id===null?null:String(row.current_round_instance_id),
      sharedVersion:Number(row.shared_version),
      lastEventSeq:Number(row.last_event_seq),
      runtimeRevision:String(row.runtime_revision),
      createdAt:String(row.created_at),
      updatedAt:String(row.updated_at),
    }
  }

  private mapPlayer(row:Row):RoomPlayerRecord {
    return {
      id:String(row.id),roomId:String(row.room_id),seatNo:Number(row.seat_no),
      roleId:row.role_id===null?null:String(row.role_id),
      controller:String(row.controller) as RoomPlayerRecord['controller'],
      displayName:String(row.display_name),
      userId:row.user_id===null?null:String(row.user_id),
      agentSessionId:row.agent_session_id===null?null:String(row.agent_session_id),
      status:String(row.status),createdAt:String(row.created_at),
    }
  }

  private mapRound(row:Row):RoundInstanceRecord {
    return {
      id:String(row.id),roomId:String(row.room_id),roundDefinitionId:String(row.round_definition_id),
      roundIndex:Number(row.round_index),type:String(row.type) as RoundInstanceRecord['type'],
      status:String(row.status) as RoundInstanceRecord['status'],
      publicVersionAtStart:Number(row.public_version_at_start),
      turnOrder:json<string[]>(String(row.turn_order_json)),turnIndex:Number(row.turn_index),
      startedAt:String(row.started_at),completedAt:row.completed_at===null?null:String(row.completed_at),
    }
  }

  private mapRoundState(row:Row):PlayerRoundStateRecord {
    return {
      roundInstanceId:String(row.round_instance_id),roomPlayerId:String(row.room_player_id),
      lastSeenPublicVersion:Number(row.last_seen_public_version),
      doneAtPublicVersion:row.done_at_public_version===null?null:Number(row.done_at_public_version),
      activationCount:Number(row.activation_count),initialActionDone:Boolean(row.initial_action_done),
      searchActionsUsed:Number(row.search_actions_used),searchFinished:Boolean(row.search_finished),
      updatedAt:String(row.updated_at),
    }
  }

  private mapEvent(row:Row):RoomEventRecord {
    return {
      id:String(row.id),roomId:String(row.room_id),
      roundInstanceId:row.round_instance_id===null?null:String(row.round_instance_id),
      seq:Number(row.seq),actorPlayerId:row.actor_player_id===null?null:String(row.actor_player_id),
      type:String(row.event_type) as RoomEventType,visibility:String(row.visibility) as EventVisibility,
      ownerPlayerId:row.owner_player_id===null?null:String(row.owner_player_id),
      targetPlayerId:row.target_player_id===null?null:String(row.target_player_id),
      payload:json<Record<string,unknown>>(String(row.payload_json)),createdAt:String(row.created_at),
    }
  }

  private mapHolding(row:Row):ClueHoldingRecord {
    return {
      id:String(row.id),roomId:String(row.room_id),roomPlayerId:String(row.room_player_id),
      clueId:String(row.clue_id),acquiredEventId:String(row.acquired_event_id),
      state:String(row.state) as 'private'|'public',
      revealedEventId:row.revealed_event_id===null?null:String(row.revealed_event_id),
      createdAt:String(row.created_at),
    }
  }

  private mapQuestion(row:Row):PendingInteractionRecord {
    return {
      id:String(row.id),roomId:String(row.room_id),roundInstanceId:String(row.round_instance_id),
      type:'question',fromPlayerId:String(row.from_player_id),toPlayerId:String(row.to_player_id),
      sourceEventId:String(row.source_event_id),
      status:String(row.status) as PendingInteractionRecord['status'],
      resolvedEventId:row.resolved_event_id===null?null:String(row.resolved_event_id),
      createdAt:String(row.created_at),resolvedAt:row.resolved_at===null?null:String(row.resolved_at),
    }
  }
}
