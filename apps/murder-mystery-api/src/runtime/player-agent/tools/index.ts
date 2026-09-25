import { randomUUID } from 'node:crypto'
import { Type, type Static, type TSchema } from 'typebox'
import type { AgentHarnessTool, ExecutionToolContext } from '@earendil-works/pi-agent-core'
import { RoomCommandService } from '../../../domain/room/commands.js'

type ToolDetails = Record<string, unknown>

function asResult(details:ToolDetails,terminate=false) {
  return {
    content:[{type:'text' as const,text:JSON.stringify(details)}],
    details,
    ...(terminate?{terminate:true}:{}),
  }
}

function createTool<T extends TSchema>(
  name:string,
  label:string,
  description:string,
  parameters:T,
  execute:(params:Static<T>)=>ToolDetails|Promise<ToolDetails>,
  terminate=false,
):AgentHarnessTool<ExecutionToolContext,T,ToolDetails> {
  return {
    name,
    label,
    description,
    parameters,
    executionMode:'sequential',
    replay:'never',
    async execute(_toolCallId,params) {
      return asResult(await execute(params),terminate)
    },
  }
}

export function createPlayerTools(
  commands:RoomCommandService,
  roomId:string,
  playerId:string,
):AgentHarnessTool<ExecutionToolContext>[] {
  return [
    createTool(
      'send_message','公开发言',
      '向房间公共群聊发言。只发送你真的希望所有玩家看到的内容；不要重复自己已经说过的话。',
      Type.Object({content:Type.String({minLength:1,maxLength:1200})},{additionalProperties:false}),
      params=>commands.sendMessage(roomId,playerId,randomUUID(),params.content),
    ),
    createTool(
      'ask_player','向指定玩家提问',
      '公开向一个指定玩家提问。targetPlayerId 必须来自当前玩家列表。目标玩家会收到明确的 direct_question 触发。',
      Type.Object({
        targetPlayerId:Type.String({minLength:1}),
        question:Type.String({minLength:1,maxLength:1200}),
      },{additionalProperties:false}),
      params=>commands.askPlayer(roomId,playerId,randomUUID(),params.targetPlayerId,params.question),
    ),
    createTool(
      'reply_question','回答指定问题',
      '回答明确发给你的 pending question。可以诚实回答、部分回答或基于角色目标进行误导，但必须针对该问题。',
      Type.Object({
        questionId:Type.String({minLength:1}),
        content:Type.String({minLength:1,maxLength:1200}),
      },{additionalProperties:false}),
      params=>commands.replyQuestion(roomId,playerId,randomUUID(),params.questionId,params.content),
    ),
    createTool(
      'decline_question','拒绝回答指定问题',
      '当角色决定不回答一个明确问题时使用。该动作只会结束这个待回答问题，不会在公共群聊额外发送“拒绝回答”提示。',
      Type.Object({questionId:Type.String({minLength:1})},{additionalProperties:false}),
      params=>commands.declineQuestion(roomId,playerId,randomUUID(),params.questionId),
    ),
    createTool(
      'yield_turn','暂时等待',
      '当前没有立即行动，但你还不想声明本轮结束时使用。',
      Type.Object({}, {additionalProperties:false}),
      ()=>commands.yieldTurn(roomId,playerId,randomUUID()),
    ),
    createTool(
      'finish_round','结束本轮讨论',
      '当你认为自己本轮讨论已经完成、后续即使有新消息也不再参与本轮时使用。执行后本轮不会再次激活你。若只是当前这条消息不想回应，应使用 pass。',
      Type.Object({}, {additionalProperties:false}),
      ()=>commands.finishRound(roomId,playerId,randomUUID()),
      true,
    ),
    createTool(
      'pass','静默不回应',
      '当前公共状态下没有值得公开的新内容时使用。不会向群聊发送任何消息；执行后立即结束本次激活。之后出现新的公共信息时，你仍可再次被激活并重新判断。若有待回答的定向问题，不允许使用 pass。',
      Type.Object({}, {additionalProperties:false}),
      ()=>commands.pass(roomId,playerId,randomUUID()),
      true,
    ),
    createTool(
      'search_clue','搜证',
      '在当前搜证轮选择一个地点进行一次搜证。',
      Type.Object({locationId:Type.String({minLength:1})},{additionalProperties:false}),
      params=>commands.searchClue(roomId,playerId,randomUUID(),params.locationId),
    ),
    createTool(
      'reveal_clue','公开私有线索',
      '把你当前持有的一条私有线索公开给全房间。',
      Type.Object({holdingId:Type.String({minLength:1})},{additionalProperties:false}),
      params=>commands.revealClue(roomId,playerId,randomUUID(),params.holdingId),
    ),
    createTool(
      'keep_clue_private','暂不公开线索',
      '明确选择暂不公开一条自己持有的线索。',
      Type.Object({holdingId:Type.String({minLength:1})},{additionalProperties:false}),
      params=>commands.keepCluePrivate(roomId,playerId,randomUUID(),params.holdingId),
    ),
    createTool(
      'finish_search','结束本轮搜证',
      '完成当前搜证轮自己的行动。可在额度用完或决定不继续搜证时使用。',
      Type.Object({}, {additionalProperties:false}),
      ()=>commands.finishSearch(roomId,playerId,randomUUID()),
    ),
    createTool(
      'submit_vote','提交最终投票',
      '密封提交你的最终投票。其他玩家在全部投票完成前无法看到。',
      Type.Object({
        targetRoleId:Type.String({minLength:1}),
        reasoning:Type.Optional(Type.String({maxLength:2000})),
      },{additionalProperties:false}),
      params=>commands.submitVote(roomId,playerId,randomUUID(),params.targetRoleId,params.reasoning),
    ),
  ]
}
