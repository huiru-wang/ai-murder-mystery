import { GameDirector } from '../../domain/round/director.js'
import { ScriptRepository } from '../../domain/script/repository.js'
import { RoomRepository } from '../../domain/room/repository.js'
import type { AgentTrigger } from './trigger.js'

export type PlayerAgentContext = {
  systemPrompt:string
  dynamicPrompt:string
  introductionText:string
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
    const agentAllowedTools=trigger.type==='nudge'
      ? definition.allowedTools.filter(tool=>tool!=='pass')
      : definition.allowedTools
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
      '每次被激活后，你必须至少调用一个当前允许的工具来结束这次行动。普通文本输出不会被其他玩家看到，也不会算作有效行动。',
      '# 自由讨论的节奏与收敛',
      '新的公共消息出现时，你可能会被再次唤醒。被唤醒不代表你必须公开发言。',
      '阅读最新群聊和线索后，自主判断当前是否有值得公开的新内容。',
      '只有当你有新的事实、推理、质疑、问题、澄清或策略性表达时，才使用公开行动工具。',
      '如果当前没有新的信息增量，直接调用 pass。',
      '不要为了保持聊天活跃而发言，也不要机械重复自己或他人已经公开表达过的观点。',
      '不要通过 send_message 发送“没有补充”“我先听听”“暂时没什么要说”等无信息量内容。',
      'pass 是静默动作，其他玩家看不到；它只表示你对当前公共状态没有要公开的内容。',
      '即使之前调用过 pass，只要后来出现新的公共信息，你仍然可以再次被激活并重新判断。',
      '只有当你认为自己这一整轮讨论已经完成，并且后续即使出现新消息也不再参与本轮时，才调用 finish_round。finish_round 一旦执行，本轮不会再次唤醒你。',
      '被直接提问时不能 pass，必须 reply_question 或 decline_question。',
      '搜证轮完成行动后调用 finish_search。自我介绍轮是例外：必须公开介绍自己一次，不能跳过。',
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
      if(event.type==='discussion_pacing_reminder') return `#${event.seq} [系统控场] ${String(event.payload.content??'本轮讨论已持续较长时间，请适当收敛。')}`
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
      definition.type==='discussion'&&definition.requiredAction==='introduce'
        ? '规则：这是自我介绍环节。你必须调用 send_message 公开介绍自己一次；成功发言后本人的介绍立即结束。不要提问，不要跳过。'
        : '',
      trigger.type==='nudge'
        ? '真人玩家正在催促你尽快完成本轮：如果还有值得公开的新内容，立即使用相应工具说出来；如果没有新的关键内容，直接调用 finish_round 结束本轮。催促状态下不要使用 pass，也不要为了拖延而重复旧观点。'
        : '',
      trigger.pacing
        ? `自由讨论控场状态：已持续约 ${trigger.pacing.elapsedMinutes} 分钟，公开交流 ${trigger.pacing.publicMessageCount}/${trigger.pacing.limitPublicMessages} 条，累计 AI 激活 ${trigger.pacing.activationCount}/${trigger.pacing.limitAgentActivations} 次，已结束 ${trigger.pacing.finishedPlayerCount}/${trigger.pacing.totalPlayerCount} 名玩家。控场阈值为 ${trigger.pacing.limitMinutes} 分钟、${trigger.pacing.limitPublicMessages} 条公开交流或 ${trigger.pacing.limitAgentActivations} 次 AI 激活，任一达到后将提醒全桌收敛。若你有关键事实、推理或必须追问的问题，请在本轮尽快通过工具表达；不要等到临近阈值才开始展开。`
        : '',
      trigger.pacing?.level==='should_wrap_up'
        ? `控场提醒：本轮已持续约 ${trigger.pacing.elapsedMinutes} 分钟，公开交流 ${trigger.pacing.publicMessageCount} 条，累计 AI 激活 ${trigger.pacing.activationCount} 次，已有 ${trigger.pacing.finishedPlayerCount}/${trigger.pacing.totalPlayerCount} 名玩家结束本轮。若你已经表达核心观点、没有新的关键事实或必须追问的问题，应倾向于调用 finish_round；如果仍有重要内容，可以继续讨论，不要为了结束而强行结束。`
        : '',
      `允许工具：${agentAllowedTools.join(', ')}`,
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
      '重要：这次激活必须通过调用一个允许的工具结束。不要只输出普通文本；若当前不想公开行动，调用 pass。',
    ].filter(Boolean).join('\n')

    return {
      systemPrompt,
      dynamicPrompt,
      introductionText:`我是${role.name}，${role.occupation}。${role.publicProfile}`,
    }
  }
}
