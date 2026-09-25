import { GameDirector } from '../../domain/round/director.js'
import { ScriptRepository } from '../../domain/script/repository.js'
import { RoomRepository } from '../../domain/room/repository.js'
import type { AgentTrigger } from './trigger.js'

export type PlayerAgentContext = {
  systemPrompt:string
  dynamicPrompt:string
  introductionText:string
  discussionFallbackText:string
}

export class PlayerAgentContextBuilder {
  constructor(
    private readonly rooms:RoomRepository,
    private readonly scripts:ScriptRepository,
    private readonly director:GameDirector,
  ) {}

  build(roomId:string,playerId:string,trigger:AgentTrigger):PlayerAgentContext {
    const room=this.rooms.requireRoom(roomId)
    const player=this.rooms.requirePlayer(roomId,playerId)
    if(!player.roleId) throw new Error('PLAYER_HAS_NO_ROLE')
    const script=this.scripts.getByVersionId(room.scriptVersionId)
    if(!script) throw new Error('SCRIPT_VERSION_NOT_FOUND')
    const role=script.roles.find(item=>item.id===player.roleId)
    if(!role) throw new Error('ROLE_NOT_FOUND')
    const round=this.rooms.getCurrentRound(roomId)
    if(!round) throw new Error('NO_ACTIVE_ROUND')
    const definition=this.director.definition(roomId)
    const players=this.rooms.listPlayers(roomId)
    const publicEvents=this.rooms.listPublicEvents(roomId)
    const holdings=this.rooms.listHoldings(roomId)
    const publicClues=[...new Set(
      holdings.filter(item=>item.state==='public').map(item=>item.clueId)
    )].map(clueId=>script.clues.find(clue=>clue.id===clueId)).filter(Boolean)
    const privateHoldings=holdings.filter(item=>item.state==='private'&&item.roomPlayerId===playerId)
    const pending=this.rooms.listPendingQuestions(roomId).filter(question=>question.toPlayerId===playerId)
    const playerRoundState=this.rooms.requireRoundState(round.id,playerId)
    const playerLabel=(roomPlayer:typeof players[number])=>
      (roomPlayer.roleId?script.roles.find(item=>item.id===roomPlayer.roleId)?.name:undefined)??roomPlayer.displayName

    const systemPrompt=[
      '# 剧本杀玩家原则',
      '你是本局剧本杀中的一个玩家，不是主持人，也不是助手。',
      '始终以角色身份自主行动，目标是完成自己的角色目标，同时参与推理。',
      '你只能使用当前提供给你的公开信息、自己的角色私密信息和自己的私有线索。',
      '你不知道其他角色的私密剧本、秘密和未公开线索，也不要假装知道。',
      '你可以隐瞒对自己不利的信息；若角色允许，可以对自己的行为撒谎或回避。',
      '绝不能创造剧本中不存在的人物、地点、物证、系统记录或已经发生的事实。',
      '不要机械重复自己已经公开说过的观点。被直接提问时，应针对具体问题回应；可以回答、部分回答、误导或明确拒绝。',
      '所有游戏行为必须通过工具完成。不要把普通模型文本当作对玩家可见的发言。',
      '普通讨论中，如果当前没有值得说、问或公开的信息，调用 finish_round；搜证轮完成行动后调用 finish_search。自我介绍轮是例外：必须公开介绍自己一次，不能跳过。',
      '',
      '# 剧本公开背景',
      script.publicContext,
      '',
      '# 你的角色',
      `${role.name}｜${role.age}岁｜${role.gender}｜${role.occupation}`,
      role.publicProfile,
      '',
      '# 你的私密剧本',
      role.privateStory,
      '',
      '# 你已知的事实',
      ...role.knownFacts.map(item=>`- ${item}`),
      '',
      '# 你的秘密',
      ...role.secrets.map(item=>`- ${item}`),
      '',
      '# 你的目标',
      ...role.goals.map(item=>`- ${item}`),
      '',
      '# 关系',
      ...role.relationships.map(item=>`- ${item}`),
      '',
      '# 欺骗边界',
      `可隐瞒自己的事实：${role.deceptionPolicy.mayHideOwnFacts?'是':'否'}`,
      `可对自己的行为撒谎：${role.deceptionPolicy.mayLieAboutOwnActions?'是':'否'}`,
      `禁止创造世界事实：${role.deceptionPolicy.forbiddenWorldFabrication?'是':'否'}`,
    ].join('\n')

    const timeline=publicEvents.map(event=>{
      const actor=event.actorPlayerId?playerLabel(players.find(item=>item.id===event.actorPlayerId)!)??event.actorPlayerId:'系统'
      const target=event.targetPlayerId?playerLabel(players.find(item=>item.id===event.targetPlayerId)!)??event.targetPlayerId:null
      if(event.type==='message_sent') return `#${event.seq} ${actor}：${String(event.payload.content??'')}`
      if(event.type==='question_asked') return `#${event.seq} ${actor} → @${target}：${String(event.payload.content??'')}`
      if(event.type==='question_replied') return `#${event.seq} ${actor} → ${target}：${String(event.payload.content??'')}`
      if(event.type==='question_declined') return ''
      if(event.type==='clue_revealed') return `#${event.seq} [公开线索] ${String(event.payload.title??'')}：${String(event.payload.content??'')}`
      if(event.type==='round_started') return `#${event.seq} [系统] 进入 ${String(event.payload.roundDefinitionId??'新轮次')}`
      return `#${event.seq} [系统] ${event.type}`
    }).filter(Boolean)

    const pendingText=pending.map(question=>{
      const source=publicEvents.find(event=>event.id===question.sourceEventId)
      const from=playerLabel(players.find(item=>item.id===question.fromPlayerId)!)??question.fromPlayerId
      return `- questionId=${question.id}，${from}问你：“${String(source?.payload.content??'')}”`
    })

    const dynamicPrompt=[
      '# 本次激活',
      `trigger.type = ${trigger.type}`,
      `directedToYou = ${trigger.directedToYou}`,
      trigger.questionId?`questionId = ${trigger.questionId}`:'',
      trigger.fromPlayerId?`fromPlayerId = ${trigger.fromPlayerId}`:'',
      '',
      '# 当前轮次',
      `round = ${definition.id}`,
      `type = ${definition.type}`,
      definition.type==='discussion'?`mode = ${definition.mode}`:'',
      definition.id==='introduction'
        ? '规则：这是自我介绍环节。你必须调用 send_message 公开介绍自己一次；成功发言后本人的介绍立即结束。不要提问，不要跳过。'
        : '',
      trigger.type==='nudge'
        ? '真人玩家正在催促你确认本轮是否还有内容。请重新查看最新公共信息：有新的必要内容就行动；没有就直接调用 finish_round。不要为了回应催促而重复旧观点。'
        : '',
      `允许工具：${definition.allowedTools.join(', ')}`,
      '',
      '# 所有玩家公开身份',
      ...players.map(item=>{
        const publicRole=item.roleId?script.roles.find(roleItem=>roleItem.id===item.roleId):undefined
        return `- playerId=${item.id}｜roleId=${item.roleId??'none'}｜${playerLabel(item)}｜${publicRole?.name??'未选角色'}｜${publicRole?.publicProfile??''}`
      }),
      '',
      '# 当前公开线索',
      ...(publicClues.length?publicClues.map(clue=>`- ${clue!.title}：${clue!.content}`):['- 暂无']),
      '',
      '# 你自己的未公开线索',
      ...(privateHoldings.length?privateHoldings.map(holding=>{
        const clue=script.clues.find(item=>item.id===holding.clueId)
        return clue
          ? `- holdingId=${holding.id}｜clueId=${clue.id}｜${clue.title}：${clue.content}`
          : `- holdingId=${holding.id}｜clueId=${holding.clueId}`
      }):['- 暂无']),
      '',
      ...(definition.type==='search'?[
        '# 当前可搜地点与额度',
        ...script.locations.map(location=>`- locationId=${location.id}｜${location.name}：${location.description}`),
        `已使用搜证次数：${playerRoundState.searchActionsUsed}/${definition.actionsPerPlayer}`,
        '',
      ]:[]),
      '# 当前公开群聊与事件',
      ...(timeline.length?timeline:['- 暂无']),
      '',
      '# 当前明确发给你的问题',
      ...(pendingText.length?pendingText:['- 暂无']),
      '',
      '根据当前信息和角色目标自主决定行动。被直接提问时优先处理对应 questionId。',
    ].filter(Boolean).join('\n')

    return {
      systemPrompt,
      dynamicPrompt,
      introductionText:`我是${role.name}，${role.occupation}。${role.publicProfile}`,
      discussionFallbackText:`我先从案发前后的时间线入手。大家可以补充一下停电前后各自的位置和行动。`,
    }
  }
}
