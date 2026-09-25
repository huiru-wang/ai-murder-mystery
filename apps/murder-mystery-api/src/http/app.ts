import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type {
  ClueDecisionRequest,
  CreateRoomRequest,
  FinishRoundRequest,
  MessageActionRequest,
  NudgePlayerRequest,
  QuestionActionRequest,
  QuestionDecisionRequest,
  ReplyQuestionRequest,
  SearchActionRequest,
  SelectRoleRequest,
  VoteActionRequest,
} from '@ai-murder-mystery/shared'
import { RoomCommandService } from '../domain/room/commands.js'
import { RoomQueryService } from '../domain/room/queries.js'
import { RoomRepository } from '../domain/room/repository.js'
import type { PlayerAgentRuntime } from '../runtime/player-agent/runtime.js'
import { RoomScheduler } from '../runtime/scheduler/room-scheduler.js'

export function createApp(deps:{
  rooms:RoomRepository
  commands:RoomCommandService
  queries:RoomQueryService
  runtime:PlayerAgentRuntime
  scheduler:RoomScheduler
}) {
  const app=new Hono()
  app.use('*',cors())

  const fail=(c:any,error:unknown,status=400)=>
    c.json({error:error instanceof Error?error.message:'UNKNOWN_ERROR'},status)

  const human=(roomId:string,playerId:string)=>{
    const player=deps.rooms.requirePlayer(roomId,playerId)
    if(player.controller!=='human') throw new Error('HUMAN_PLAYER_REQUIRED')
    return player
  }

  const kick=(roomId:string)=>{
    deps.scheduler.kick(roomId)
  }

  app.get('/health',c=>c.json({ok:true}))
  app.get('/api/scripts',c=>c.json({items:deps.queries.listScripts()}))

  app.post('/api/rooms',async c=>{
    try {
      const body=await c.req.json<CreateRoomRequest>()
      const room=deps.commands.createRoom(body.scriptId,body.humanCount??1)
      const first=deps.rooms.listPlayers(room.id)[0]
      return c.json(deps.queries.view(room.id,first?.id),201)
    } catch(error) { return fail(c,error) }
  })

  app.get('/api/rooms/:id',c=>{
    try {
      const playerId=c.req.query('playerId')
      if(!playerId) throw new Error('PLAYER_ID_REQUIRED')
      human(c.req.param('id'),playerId)
      return c.json(deps.queries.view(c.req.param('id'),playerId))
    } catch(error) { return fail(c,error,404) }
  })

  app.post('/api/rooms/:id/select-role',async c=>{
    try {
      const body=await c.req.json<SelectRoleRequest>()
      human(c.req.param('id'),body.playerId)
      deps.commands.selectRole(c.req.param('id'),body.playerId,body.roleId)
      return c.json(deps.queries.view(c.req.param('id'),body.playerId))
    } catch(error) { return fail(c,error) }
  })

  app.post('/api/rooms/:id/start',async c=>{
    try {
      const body=await c.req.json<{playerId:string}>()
      human(c.req.param('id'),body.playerId)
      const roomId=c.req.param('id')
      const current=deps.queries.view(roomId,body.playerId)
      if(current.players.length<current.script.playerCount) deps.runtime.assertReady()
      deps.commands.startRoom(roomId)
      await deps.runtime.ensureRoomSessions(roomId)
      kick(roomId)
      return c.json(deps.queries.view(roomId,body.playerId))
    } catch(error) { return fail(c,error) }
  })

  app.post('/api/rooms/:id/actions/message',async c=>{
    try {
      const body=await c.req.json<MessageActionRequest>()
      human(c.req.param('id'),body.playerId)
      deps.commands.sendMessage(c.req.param('id'),body.playerId,body.commandId,body.content)
      kick(c.req.param('id'))
      return c.json(deps.queries.view(c.req.param('id'),body.playerId))
    } catch(error) { return fail(c,error) }
  })

  app.post('/api/rooms/:id/actions/question',async c=>{
    try {
      const body=await c.req.json<QuestionActionRequest>()
      human(c.req.param('id'),body.playerId)
      deps.commands.askPlayer(c.req.param('id'),body.playerId,body.commandId,body.targetPlayerId,body.question)
      kick(c.req.param('id'))
      return c.json(deps.queries.view(c.req.param('id'),body.playerId))
    } catch(error) { return fail(c,error) }
  })

  app.post('/api/rooms/:id/actions/reply',async c=>{
    try {
      const body=await c.req.json<ReplyQuestionRequest>()
      human(c.req.param('id'),body.playerId)
      deps.commands.replyQuestion(c.req.param('id'),body.playerId,body.commandId,body.questionId,body.content)
      kick(c.req.param('id'))
      return c.json(deps.queries.view(c.req.param('id'),body.playerId))
    } catch(error) { return fail(c,error) }
  })

  app.post('/api/rooms/:id/actions/decline-question',async c=>{
    try {
      const body=await c.req.json<QuestionDecisionRequest>()
      human(c.req.param('id'),body.playerId)
      deps.commands.declineQuestion(c.req.param('id'),body.playerId,body.commandId,body.questionId)
      kick(c.req.param('id'))
      return c.json(deps.queries.view(c.req.param('id'),body.playerId))
    } catch(error) { return fail(c,error) }
  })

  app.post('/api/rooms/:id/actions/finish-round',async c=>{
    try {
      const body=await c.req.json<FinishRoundRequest>()
      human(c.req.param('id'),body.playerId)
      deps.commands.finishRound(c.req.param('id'),body.playerId,body.commandId)
      kick(c.req.param('id'))
      return c.json(deps.queries.view(c.req.param('id'),body.playerId))
    } catch(error) { return fail(c,error) }
  })

  app.post('/api/rooms/:id/actions/nudge',async c=>{
    try {
      const body=await c.req.json<NudgePlayerRequest>()
      human(c.req.param('id'),body.playerId)
      deps.scheduler.nudge(c.req.param('id'),body.targetPlayerId)
      kick(c.req.param('id'))
      return c.json(deps.queries.view(c.req.param('id'),body.playerId))
    } catch(error) { return fail(c,error) }
  })

  app.post('/api/rooms/:id/actions/search',async c=>{
    try {
      const body=await c.req.json<SearchActionRequest>()
      human(c.req.param('id'),body.playerId)
      deps.commands.searchClue(c.req.param('id'),body.playerId,body.commandId,body.locationId)
      kick(c.req.param('id'))
      return c.json(deps.queries.view(c.req.param('id'),body.playerId))
    } catch(error) { return fail(c,error) }
  })

  app.post('/api/rooms/:id/actions/reveal-clue',async c=>{
    try {
      const body=await c.req.json<ClueDecisionRequest>()
      human(c.req.param('id'),body.playerId)
      deps.commands.revealClue(c.req.param('id'),body.playerId,body.commandId,body.holdingId)
      kick(c.req.param('id'))
      return c.json(deps.queries.view(c.req.param('id'),body.playerId))
    } catch(error) { return fail(c,error) }
  })

  app.post('/api/rooms/:id/actions/keep-clue-private',async c=>{
    try {
      const body=await c.req.json<ClueDecisionRequest>()
      human(c.req.param('id'),body.playerId)
      deps.commands.keepCluePrivate(c.req.param('id'),body.playerId,body.commandId,body.holdingId)
      return c.json(deps.queries.view(c.req.param('id'),body.playerId))
    } catch(error) { return fail(c,error) }
  })

  app.post('/api/rooms/:id/actions/finish-search',async c=>{
    try {
      const body=await c.req.json<FinishRoundRequest>()
      human(c.req.param('id'),body.playerId)
      deps.commands.finishSearch(c.req.param('id'),body.playerId,body.commandId)
      kick(c.req.param('id'))
      return c.json(deps.queries.view(c.req.param('id'),body.playerId))
    } catch(error) { return fail(c,error) }
  })

  app.post('/api/rooms/:id/actions/vote',async c=>{
    try {
      const body=await c.req.json<VoteActionRequest>()
      human(c.req.param('id'),body.playerId)
      deps.commands.submitVote(c.req.param('id'),body.playerId,body.commandId,body.targetRoleId,body.reasoning)
      kick(c.req.param('id'))
      return c.json(deps.queries.view(c.req.param('id'),body.playerId))
    } catch(error) { return fail(c,error) }
  })

  app.post('/api/rooms/:id/pump',async c=>{
    try {
      const result=await deps.scheduler.pump(c.req.param('id'))
      return c.json({result})
    } catch(error) { return fail(c,error) }
  })

  return app
}
