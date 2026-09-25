import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { RoomCommandService } from '../src/domain/room/commands.js'
import { RoomQueryService } from '../src/domain/room/queries.js'
import { RoomRepository } from '../src/domain/room/repository.js'
import { GameDirector, shuffledTurnOrder } from '../src/domain/round/director.js'
import { ScriptRepository } from '../src/domain/script/repository.js'
import { ScriptPackageImporter } from '../src/domain/script/importer.js'
import { assertLiveModelConfigured, readSchedulerConfig } from '../src/infra/config/ai.js'
import { MurderMysteryDatabase } from '../src/infra/sqlite/database.js'
import { PlayerAgentContextBuilder } from '../src/runtime/player-agent/context-builder.js'
import { MockPlayerAgentRuntime } from '../src/runtime/player-agent/runtime.js'
import { createPlayerTools } from '../src/runtime/player-agent/tools/index.js'
import { RoomScheduler } from '../src/runtime/scheduler/room-scheduler.js'

const seventhPierPackage=resolve(dirname(fileURLToPath(import.meta.url)),'../../../data/scripts/第七码头.zip')

function createWorld() {
  const database = new MurderMysteryDatabase(':memory:')
  const scripts = new ScriptRepository(database)
  const importer = new ScriptPackageImporter(scripts)
  importer.importZip(readFileSync(seventhPierPackage))
  const rooms = new RoomRepository(database)
  const director = new GameDirector(rooms, scripts)
  const commands = new RoomCommandService(rooms, scripts, director)
  const queries = new RoomQueryService(rooms, scripts, director)
  const contextBuilder = new PlayerAgentContextBuilder(rooms, scripts, director)
  const runtime = new MockPlayerAgentRuntime(rooms, scripts, director, commands)
  const scheduler = new RoomScheduler(rooms, director, runtime)
  return { database, scripts, rooms, director, commands, queries, contextBuilder, runtime, scheduler }
}

test('script repository is empty until a ZIP package is imported and persists the published version', () => {
  const database=new MurderMysteryDatabase(':memory:')
  try {
    const scripts=new ScriptRepository(database)
    assert.deepEqual(scripts.list(),[])
    const script=new ScriptPackageImporter(scripts).importZip(readFileSync(seventhPierPackage))
    assert.equal(script.id,'seventh-pier')
    assert.equal(scripts.list().length,1)
    assert.equal(scripts.getByVersionId('seventh-pier@2.0.0')?.title,'第七码头')
  } finally { database.close() }
})

test('published script versions survive a database restart', () => {
  const directory=mkdtempSync(join(tmpdir(),'murder-mystery-script-restart-'))
  const path=join(directory,'game.sqlite')
  try {
    const first=new MurderMysteryDatabase(path)
    new ScriptPackageImporter(new ScriptRepository(first)).importZip(readFileSync(seventhPierPackage))
    first.close()
    const restored=new MurderMysteryDatabase(path)
    assert.equal(new ScriptRepository(restored).getById('seventh-pier')?.version,'2.0.0')
    restored.close()
  } finally { rmSync(directory,{recursive:true,force:true}) }
})

test('script importer rejects invalid ZIP content without publishing a version', () => {
  const database=new MurderMysteryDatabase(':memory:')
  try {
    const scripts=new ScriptRepository(database)
    assert.throws(()=>new ScriptPackageImporter(scripts).importZip(Buffer.from('not a zip')),/SCRIPT_PACKAGE_INVALID/)
    assert.deepEqual(scripts.list(),[])
  } finally { database.close() }
})

function startOneHuman(w: ReturnType<typeof createWorld>) {
  const room = w.commands.createRoom('seventh-pier', 1)
  const human = w.rooms.listPlayers(room.id)[0]!
  assert.equal(human.displayName, '玩家1')
  w.commands.selectRole(room.id, human.id, 'xu-cheng')
  const selectedHuman = w.rooms.requirePlayer(room.id, human.id)
  assert.equal(selectedHuman.displayName, '许澄')
  w.commands.startRoom(room.id)
  const script = w.scripts.getById('seventh-pier')!
  assert.ok(w.rooms.listPlayers(room.id).filter(player => player.controller === 'agent').every(player =>
    player.displayName === script.roles.find(role => role.id === player.roleId)?.name
  ))
  return { roomId: room.id, human: selectedHuman }
}

async function finishIntroduction(w: ReturnType<typeof createWorld>, roomId: string, _humanId: string) {
  const intro = w.rooms.getCurrentRound(roomId)!
  assert.equal(w.director.definition(roomId).requiredAction, 'introduce')
  for (const playerId of intro.turnOrder) {
    const player = w.rooms.requirePlayer(roomId, playerId)
    assert.equal(w.director.isOrderedTurn(roomId, playerId), true)
    w.commands.sendMessage(roomId, playerId, randomUUID(), `我是${player.displayName}。`)
  }
  assert.equal(w.director.definition(roomId).id, 'discussion-1')
}


test('player agent context strictly isolates other roles and script truth', async () => {
  const w = createWorld()
  try {
    const { roomId } = startOneHuman(w)
    await w.runtime.ensureRoomSessions(roomId)
    const shen = w.rooms.listPlayers(roomId).find(player => player.roleId === 'shen-yan')!
    const script = w.scripts.getById('seventh-pier')!
    const lin = script.roles.find(role => role.id === 'lin-xia')!
    const context = w.contextBuilder.build(roomId, shen.id, {
      type: 'scheduled_opportunity',
      roomId,
      playerId: shen.id,
      directedToYou: false,
    })

    assert.ok(context.systemPrompt.includes('沈砚'))
    assert.ok(!context.systemPrompt.includes(lin.privateStory))
    assert.ok(!context.systemPrompt.includes(script.truth.content))
    assert.ok(!context.dynamicPrompt.includes(lin.privateStory))
    assert.ok(!context.dynamicPrompt.includes(script.truth.content))
  } finally {
    await w.runtime.close()
    w.database.close()
  }
})

test('same script and role stay isolated across rooms and agent sessions', async () => {
  const w = createWorld()
  try {
    const first = startOneHuman(w)
    const second = startOneHuman(w)
    await w.runtime.ensureRoomSessions(first.roomId)
    await w.runtime.ensureRoomSessions(second.roomId)

    const firstShen = w.rooms.listPlayers(first.roomId).find(player => player.roleId === 'shen-yan')!
    const secondShen = w.rooms.listPlayers(second.roomId).find(player => player.roleId === 'shen-yan')!
    const firstBinding = w.rooms.getAgentSessionBinding(first.roomId, firstShen.id)!
    const secondBinding = w.rooms.getAgentSessionBinding(second.roomId, secondShen.id)!

    assert.notEqual(first.roomId, second.roomId)
    assert.notEqual(firstShen.id, secondShen.id)
    assert.notEqual(firstBinding.runtimeSessionId, secondBinding.runtimeSessionId)
    assert.equal(w.rooms.getPlayer(second.roomId, first.human.id), null)

    await finishIntroduction(w, first.roomId, first.human.id)
    await finishIntroduction(w, second.roomId, second.human.id)
    w.commands.sendMessage(first.roomId, first.human.id, randomUUID(), 'ROOM-A-ONLY-MESSAGE')
    w.commands.sendMessage(second.roomId, second.human.id, randomUUID(), 'ROOM-B-ONLY-MESSAGE')

    const firstContext = w.contextBuilder.build(first.roomId, firstShen.id, {
      type: 'scheduled_opportunity', roomId: first.roomId, playerId: firstShen.id, directedToYou: false,
    })
    const secondContext = w.contextBuilder.build(second.roomId, secondShen.id, {
      type: 'scheduled_opportunity', roomId: second.roomId, playerId: secondShen.id, directedToYou: false,
    })

    assert.ok(firstContext.dynamicPrompt.includes('ROOM-A-ONLY-MESSAGE'))
    assert.ok(!firstContext.dynamicPrompt.includes('ROOM-B-ONLY-MESSAGE'))
    assert.ok(secondContext.dynamicPrompt.includes('ROOM-B-ONLY-MESSAGE'))
    assert.ok(!secondContext.dynamicPrompt.includes('ROOM-A-ONLY-MESSAGE'))
  } finally {
    await w.runtime.close()
    w.database.close()
  }
})

test('missing runtime session binding can be replaced without changing the room player', async () => {
  const w = createWorld()
  try {
    const { roomId } = startOneHuman(w)
    await w.runtime.ensureRoomSessions(roomId)
    const agent = w.rooms.listPlayers(roomId).find(player => player.controller === 'agent')!
    const original = w.rooms.getAgentSessionBinding(roomId, agent.id)!
    const replacementSessionId = randomUUID()

    w.rooms.replaceAgentSessionBinding({
      bindingId: original.id,
      roomId,
      playerId: agent.id,
      runtimeSessionId: replacementSessionId,
      agentRevision: 'v2:deepseek/deepseek-v4-pro',
    })

    const replacement = w.rooms.getAgentSessionBinding(roomId, agent.id)!
    assert.equal(replacement.id, original.id)
    assert.equal(replacement.runtimeSessionId, replacementSessionId)
    assert.equal(w.rooms.requirePlayer(roomId, agent.id).agentSessionId, replacementSessionId)
  } finally {
    await w.runtime.close()
    w.database.close()
  }
})

test('structured question creates a targeted public interaction and direct trigger', async () => {
  const w = createWorld()
  try {
    const { roomId, human } = startOneHuman(w)
    await w.runtime.ensureRoomSessions(roomId)
    await finishIntroduction(w, roomId, human.id)

    const command = randomUUID()
    w.commands.sendMessage(roomId, human.id, command, '我补充一句公开信息。')
    const countBeforeReplay = w.rooms.listEvents(roomId).length
    w.commands.sendMessage(roomId, human.id, command, '这一句不会重复写入。')
    assert.equal(w.rooms.listEvents(roomId).length, countBeforeReplay)

    const zhou = w.rooms.listPlayers(roomId).find(player => player.roleId === 'zhou-qi')!
    const result = w.commands.askPlayer(
      roomId,
      human.id,
      randomUUID(),
      zhou.id,
      '你为什么知道断电时机械钥匙还能使用？',
    ) as { questionId: string }

    const selected = w.scheduler.nextTrigger(roomId)
    assert.equal(selected.trigger?.type, 'direct_question')
    assert.equal(selected.trigger?.playerId, zhou.id)
    assert.equal(selected.trigger?.questionId, result.questionId)
    assert.equal(selected.trigger?.directedToYou, true)

    const publicQuestion = w.rooms.listPublicEvents(roomId).find(event => event.type === 'question_asked')
    assert.equal(publicQuestion?.targetPlayerId, zhou.id)
    assert.equal(publicQuestion?.payload.content, '你为什么知道断电时机械钥匙还能使用？')

    await w.scheduler.pump(roomId)
    assert.equal(w.rooms.requireQuestion(roomId, result.questionId).status, 'answered')
    assert.ok(w.rooms.listPublicEvents(roomId).some(event =>
      event.type === 'question_replied' && event.actorPlayerId === zhou.id
    ))
  } finally {
    await w.runtime.close()
    w.database.close()
  }
})

test('private clue stays isolated until reveal and pass remains temporary across public changes', async () => {
  const w = createWorld()
  try {
    const { roomId, human } = startOneHuman(w)
    const players = w.rooms.listPlayers(roomId)

    await finishIntroduction(w, roomId, human.id)
    assert.equal(w.director.definition(roomId).id, 'discussion-1')

    w.commands.pass(roomId, human.id, randomUUID())
    const discussion = w.rooms.getCurrentRound(roomId)!
    const seenAt = w.rooms.requireRoundState(discussion.id, human.id).lastSeenPublicVersion
    assert.equal(w.rooms.requireRoundState(discussion.id, human.id).discussionFinished, false)
    const shen = players.find(player => player.roleId === 'shen-yan')!
    w.commands.sendMessage(roomId, shen.id, randomUUID(), '我补充一个新的公开信息。')
    const latestVersion = w.rooms.requireRoom(roomId).sharedVersion
    assert.ok(latestVersion > seenAt)
    assert.ok(w.rooms.requireRoundState(discussion.id, human.id).lastSeenPublicVersion < latestVersion)

    w.commands.finishRound(roomId, human.id, randomUUID())
    for (const player of players.filter(player => player.controller === 'agent')) {
      w.commands.finishRound(roomId, player.id, randomUUID())
    }
    assert.equal(w.director.definition(roomId).id, 'search-1')

    const result = w.commands.searchClue(roomId, human.id, randomUUID(), 'office') as {
      holdingId: string
      clueId: string
      content: string
    }
    const holding = w.rooms.requireHolding(roomId, result.holdingId)
    assert.equal(holding.state, 'private')

    const before = w.contextBuilder.build(roomId, shen.id, {
      type: 'search_turn', roomId, playerId: shen.id, directedToYou: false,
    })
    assert.ok(!before.dynamicPrompt.includes(result.content))

    w.commands.revealClue(roomId, human.id, randomUUID(), result.holdingId)
    const after = w.contextBuilder.build(roomId, shen.id, {
      type: 'search_turn', roomId, playerId: shen.id, directedToYou: false,
    })
    assert.ok(after.dynamicPrompt.includes(result.content))
  } finally {
    await w.runtime.close()
    w.database.close()
  }
})

test('search quotas are independent and the same clue can be found by different players', async () => {
  const w = createWorld()
  try {
    const { roomId, human } = startOneHuman(w)
    const players = w.rooms.listPlayers(roomId)
    const agent = players.find(player => player.controller === 'agent')!

    await finishIntroduction(w, roomId, human.id)
    w.commands.finishRound(roomId, human.id, randomUUID())
    for (const player of players.filter(player => player.controller === 'agent')) {
      w.commands.finishRound(roomId, player.id, randomUUID())
    }

    assert.equal(w.director.definition(roomId).id, 'search-1')

    const agentResult = w.commands.searchClue(roomId, agent.id, randomUUID(), 'power-room') as {
      holdingId: string
      clueId: string
    }
    const humanResult = w.commands.searchClue(roomId, human.id, randomUUID(), 'power-room') as {
      holdingId: string
      clueId: string
    }

    assert.equal(agentResult.clueId, 'power-log')
    assert.equal(humanResult.clueId, 'power-log')
    assert.notEqual(agentResult.holdingId, humanResult.holdingId)

    const sameClueHoldings = w.rooms.listHoldings(roomId).filter(item => item.clueId === 'power-log')
    assert.equal(sameClueHoldings.length, 2)
    assert.deepEqual(new Set(sameClueHoldings.map(item => item.roomPlayerId)), new Set([agent.id, human.id]))

    const publicRevealEvents = w.rooms.listPublicEvents(roomId).filter(event =>
      event.type === 'clue_revealed' && event.payload.clueId === 'power-log'
    )
    assert.equal(publicRevealEvents.length, 1)
    assert.equal(w.queries.view(roomId, human.id).publicClues.filter(clue => clue.clueId === 'power-log').length, 1)

    const selected = w.scheduler.nextTrigger(roomId)
    assert.ok(selected.trigger)
    assert.equal(selected.blockedByHuman, false)
  } finally {
    await w.runtime.close()
    w.database.close()
  }
})

test('one human and five agents can complete the entire seventh-pier V2 flow', async () => {
  const w = createWorld()
  try {
    const { roomId, human } = startOneHuman(w)
    await w.runtime.ensureRoomSessions(roomId)
    assert.equal(w.rooms.listPlayers(roomId).filter(player => player.controller === 'agent').length, 5)
    assert.ok(w.rooms.listPlayers(roomId).filter(player => player.controller === 'agent').every(player => player.agentSessionId))

    await finishIntroduction(w, roomId, human.id)

    const zhou = w.rooms.listPlayers(roomId).find(player => player.roleId === 'zhou-qi')!
    const asked = w.commands.askPlayer(
      roomId, human.id, randomUUID(), zhou.id, '停电到底是不是人为拉闸？'
    ) as { questionId: string }
    await w.scheduler.pump(roomId)
    assert.equal(w.rooms.requireQuestion(roomId, asked.questionId).status, 'answered')

    w.commands.finishRound(roomId, human.id, randomUUID())
    await w.scheduler.pump(roomId)
    assert.equal(w.director.definition(roomId).id, 'search-1')

    await driveHumanToVote(w, roomId, human.id)
    assert.equal(w.director.definition(roomId).id, 'vote')

    await w.scheduler.pump(roomId)
    assert.equal(w.rooms.listPublicEvents(roomId).some(event => event.type === 'vote_submitted'), false)
    const beforeReveal = w.queries.view(roomId, human.id)
    assert.equal(beforeReveal.result, undefined)
    assert.equal(beforeReveal.review, undefined)

    w.commands.submitVote(roomId, human.id, randomUUID(), 'he-chuan', '公开证据链指向贺川')
    await w.scheduler.pump(roomId)

    const final = w.queries.view(roomId, human.id)
    assert.equal(final.status, 'completed')
    assert.equal(final.result?.murdererRoleId, 'he-chuan')
    assert.equal(final.result?.votes.length, 6)
    assert.ok(final.result?.truth.includes('贺川'))
    assert.equal(final.review?.roles.length, 6)
    assert.equal(final.review?.clues.length, w.scripts.getById('seventh-pier')!.clues.length)
    assert.ok(final.review?.roles.some(role => role.roleId === 'he-chuan' && role.secrets.includes('你是凶手。')))
    assert.ok(final.review?.clues.some(clue => clue.status === 'public'))
  } finally {
    await w.runtime.close()
    w.database.close()
  }
})

test('introduction order can randomize all players instead of forcing the human first', () => {
  const seatOrder=['human','ai-1','ai-2','ai-3','ai-4','ai-5']
  const randomized=shuffledTurnOrder(seatOrder,()=>0)
  assert.equal(randomized.length,seatOrder.length)
  assert.deepEqual([...randomized].sort(),[...seatOrder].sort())
  assert.notEqual(randomized[0],'human')
})

test('introduction requires exactly one public speech from every player in the persisted random order', async () => {
  const w = createWorld()
  try {
    const { roomId, human } = startOneHuman(w)
    const intro = w.rooms.getCurrentRound(roomId)!
    assert.equal(w.director.definition(roomId).requiredAction, 'introduce')
    assert.throws(() => w.commands.finishRound(roomId, human.id, randomUUID()), /TOOL_NOT_ALLOWED_IN_ROUND/)
    assert.throws(() => w.commands.yieldTurn(roomId, human.id, randomUUID()), /(TOOL_NOT_ALLOWED_IN_ROUND|NOT_ORDERED_TURN)/)

    const players = w.rooms.listPlayers(roomId)
    assert.equal(intro.turnOrder.length, players.length)
    assert.deepEqual([...intro.turnOrder].sort(), players.map(player => player.id).sort())

    for (const playerId of intro.turnOrder) {
      const player = w.rooms.requirePlayer(roomId, playerId)
      assert.equal(w.director.isOrderedTurn(roomId, playerId), true)
      w.commands.sendMessage(roomId, playerId, randomUUID(), `我是${player.displayName}。`)
    }

    assert.equal(w.director.definition(roomId).id, 'discussion-1')
    const introductions = w.rooms.listPublicEvents(roomId).filter(event =>
      event.roundInstanceId === intro.id && event.type === 'message_sent'
    )
    assert.equal(introductions.length, 6)
    assert.deepEqual(introductions.map(event => event.actorPlayerId), intro.turnOrder)
    assert.equal(new Set(introductions.map(event => event.actorPlayerId)).size, 6)
  } finally {
    await w.runtime.close()
    w.database.close()
  }
})

test('pass is silent, terminal, and a later public version can reactivate the AI', async () => {
  const w = createWorld()
  try {
    const { roomId, human } = startOneHuman(w)
    await finishIntroduction(w, roomId, human.id)
    const round = w.rooms.getCurrentRound(roomId)!
    const agents = w.rooms.listPlayers(roomId).filter(player => player.controller === 'agent')
    const first = agents[0]!

    const context = w.contextBuilder.build(roomId, first.id, {
      type:'round_started', roomId, playerId:first.id, directedToYou:false,
    })
    assert.ok(context.systemPrompt.includes('直接调用 pass'))
    assert.ok(context.dynamicPrompt.includes('pass'))
    assert.ok(context.dynamicPrompt.includes('finish_round'))
    assert.ok(context.dynamicPrompt.includes('pass'))

    const publicBefore = w.rooms.listPublicEvents(roomId).length
    const passTool = createPlayerTools(w.commands, roomId, first.id).find(tool => tool.name === 'pass')!
    const result = await (passTool.execute as any)('pass-test', {}, () => {}, undefined, undefined, undefined)
    assert.equal(result.terminate, true)
    assert.equal(w.rooms.listPublicEvents(roomId).length, publicBefore)

    const versionBefore = w.rooms.requireRoom(roomId).sharedVersion
    const firstState = w.rooms.requireRoundState(round.id, first.id)
    assert.equal(firstState.lastSeenPublicVersion, versionBefore)
    assert.equal(firstState.doneAtPublicVersion, null)
    assert.equal(firstState.discussionFinished, false)

    for (const agent of agents.slice(1)) w.commands.pass(roomId, agent.id, randomUUID())
    w.commands.sendMessage(roomId, human.id, randomUUID(), '我补充一个新的公开观点。')
    const versionAfter = w.rooms.requireRoom(roomId).sharedVersion
    assert.ok(versionAfter > versionBefore)

    const selected = w.scheduler.nextTrigger(roomId)
    assert.equal(selected.trigger?.type, 'public_state_changed')
    assert.equal(selected.trigger?.playerId, first.id)
  } finally {
    await w.runtime.close()
    w.database.close()
  }
})

test('pass cannot silently swallow a pending directed question', async () => {
  const w = createWorld()
  try {
    const { roomId, human } = startOneHuman(w)
    await finishIntroduction(w, roomId, human.id)
    const agent = w.rooms.listPlayers(roomId).find(player => player.controller === 'agent')!
    w.commands.askPlayer(roomId, human.id, randomUUID(), agent.id, '你现在怎么解释？')
    assert.throws(() => w.commands.pass(roomId, agent.id, randomUUID()), /PASS_NOT_ALLOWED_WITH_PENDING_QUESTION/)
  } finally {
    await w.runtime.close()
    w.database.close()
  }
})

test('finish_round permanently removes an AI from later free-discussion activations', async () => {
  const w = createWorld()
  try {
    const { roomId, human } = startOneHuman(w)
    await finishIntroduction(w, roomId, human.id)
    const round = w.rooms.getCurrentRound(roomId)!
    const agents = w.rooms.listPlayers(roomId).filter(player => player.controller === 'agent')
    const finished = agents[0]!
    w.commands.finishRound(roomId, finished.id, randomUUID())
    assert.equal(w.rooms.requireRoundState(round.id, finished.id).discussionFinished, true)
    assert.throws(() => w.commands.sendMessage(roomId, finished.id, randomUUID(), '我又想说话了。'), /PLAYER_ALREADY_FINISHED_ROUND/)

    for (const agent of agents.slice(1)) w.commands.finishRound(roomId, agent.id, randomUUID())
    w.commands.sendMessage(roomId, human.id, randomUUID(), '还有一个新观点。')
    const selected = w.scheduler.nextTrigger(roomId)
    assert.notEqual(selected.trigger?.playerId, finished.id)
  } finally {
    await w.runtime.close()
    w.database.close()
  }
})

test('free discussion advances only after every player explicitly finishes', async () => {
  const w = createWorld()
  try {
    const { roomId, human } = startOneHuman(w)
    await finishIntroduction(w, roomId, human.id)
    const round = w.rooms.getCurrentRound(roomId)!
    const players = w.rooms.listPlayers(roomId)
    for (const player of players.slice(0, -1)) w.commands.finishRound(roomId, player.id, randomUUID())
    assert.equal(w.director.definition(roomId).id, 'discussion-1')
    assert.equal(w.director.reconcile(roomId).advanced, false)
    w.commands.finishRound(roomId, players.at(-1)!.id, randomUUID())
    assert.equal(w.director.definition(roomId).id, 'search-1')
    assert.ok(w.rooms.listRoundStates(round.id).every(state => state.discussionFinished))
  } finally {
    await w.runtime.close()
    w.database.close()
  }
})

test('every free-discussion wake-up includes the current pacing state and thresholds', async () => {
  const w = createWorld()
  try {
    const { roomId, human } = startOneHuman(w)
    await finishIntroduction(w, roomId, human.id)
    const trigger = w.scheduler.nextTrigger(roomId).trigger
    assert.ok(trigger)
    assert.equal(trigger.pacing?.level, 'within_limit')
    const context = w.contextBuilder.build(roomId, trigger.playerId, trigger)
    assert.ok(context.dynamicPrompt.includes('自由讨论控场状态'))
    assert.ok(context.dynamicPrompt.includes('公开交流 0/30 条'))
    assert.ok(context.dynamicPrompt.includes('控场阈值为 8 分钟、30 条公开交流或 45 次 AI 激活'))
  } finally {
    await w.runtime.close()
    w.database.close()
  }
})

test('long free discussion injects pacing into agent context and posts one public reminder', async () => {
  const w = createWorld()
  try {
    const { roomId, human } = startOneHuman(w)
    await finishIntroduction(w, roomId, human.id)
    const round = w.rooms.getCurrentRound(roomId)!
    const oldStartedAt = new Date(Date.now() - 9 * 60 * 1000).toISOString()
    w.database.db.prepare('update round_instances set started_at=? where id=?').run(oldStartedAt, round.id)

    const trigger = w.scheduler.nextTrigger(roomId).trigger
    assert.ok(trigger)
    assert.equal(trigger.pacing?.level, 'should_wrap_up')
    const agent = w.rooms.requirePlayer(roomId, trigger.playerId)
    const context = w.contextBuilder.build(roomId, agent.id, trigger)
    assert.ok(context.dynamicPrompt.includes('控场提醒'))
    assert.ok(context.dynamicPrompt.includes('finish_round'))

    await w.scheduler.pump(roomId, 1)
    let reminders = w.rooms.listPublicEvents(roomId).filter(event =>
      event.roundInstanceId === round.id && event.type === 'discussion_pacing_reminder'
    )
    assert.equal(reminders.length, 1)
    assert.ok(String(reminders[0]!.payload.content).includes('本轮讨论已持续较长时间'))

    await w.scheduler.pump(roomId, 1)
    reminders = w.rooms.listPublicEvents(roomId).filter(event =>
      event.roundInstanceId === round.id && event.type === 'discussion_pacing_reminder'
    )
    assert.equal(reminders.length, 1)
    const view = w.queries.view(roomId, human.id)
    assert.ok(view.publicTimeline.some(event => event.type === 'discussion_pacing_reminder'))
  } finally {
    await w.runtime.close()
    w.database.close()
  }
})

test('nudge requires immediate action or finish and does not offer pass', async () => {
  const w = createWorld()
  try {
    const { roomId, human } = startOneHuman(w)
    await finishIntroduction(w, roomId, human.id)
    const round = w.rooms.getCurrentRound(roomId)!
    const agent = w.rooms.listPlayers(roomId).find(player => player.controller === 'agent')!
    const state = w.rooms.requireRoundState(round.id, agent.id)
    w.rooms.updateRoundState(round.id, agent.id, {
      activationCount: Math.max(1, state.activationCount),
      lastSeenPublicVersion: w.rooms.requireRoom(roomId).sharedVersion,
    })
    w.scheduler.nudge(roomId, agent.id)
    const trigger = w.scheduler.nextTrigger(roomId).trigger
    assert.equal(trigger?.type, 'nudge')
    const context = w.contextBuilder.build(roomId, agent.id, trigger!)
    assert.ok(context.dynamicPrompt.includes('直接调用 finish_round'))
    const toolsLine = context.dynamicPrompt.split('\n').find(line => line.startsWith('允许工具：')) ?? ''
    assert.ok(toolsLine.includes('finish_round'))
    assert.ok(!toolsLine.includes('pass'))
  } finally {
    await w.runtime.close()
    w.database.close()
  }
})

test('removing a room deletes it and prevents future scheduler work', async () => {
  const w = createWorld()
  try {
    const { roomId, human } = startOneHuman(w)
    await finishIntroduction(w, roomId, human.id)
    await w.runtime.ensureRoomSessions(roomId)
    assert.ok(w.rooms.getRoom(roomId))
    assert.ok(w.rooms.listActiveRoomIds().includes(roomId))

    await w.scheduler.removeRoom(roomId)

    assert.equal(w.rooms.getRoom(roomId), null)
    assert.ok(!w.rooms.listActiveRoomIds().includes(roomId))
    assert.deepEqual(await w.scheduler.pump(roomId), {activations:0,blockedByHuman:false,idle:true})
    w.scheduler.kick(roomId)
  } finally {
    await w.runtime.close()
    w.database.close()
  }
})

test('unfinished AI stays pending until new public information or an explicit nudge', async () => {
  const w = createWorld()
  try {
    const { roomId, human } = startOneHuman(w)
    await finishIntroduction(w, roomId, human.id)

    const round = w.rooms.getCurrentRound(roomId)!
    const agent = w.rooms.listPlayers(roomId).find(player => player.controller === 'agent')!
    const current = w.rooms.requireRoom(roomId)
    const state = w.rooms.requireRoundState(round.id, agent.id)
    w.rooms.updateRoundState(round.id, agent.id, {
      activationCount: Math.max(1, state.activationCount),
      lastSeenPublicVersion: current.sharedVersion,
      doneAtPublicVersion: null,
    })

    const idle = w.scheduler.nextTrigger(roomId)
    assert.notEqual(idle.trigger?.playerId, agent.id)

    const before = w.queries.view(roomId, human.id).players.find(player => player.id === agent.id)!
    assert.equal(before.roundStatus, 'needs_confirmation')
    assert.equal(before.canNudge, true)

    const zhou = w.rooms.listPlayers(roomId).find(player => player.roleId === 'zhou-qi')!
    const question = w.commands.askPlayer(
      roomId, zhou.id, randomUUID(), human.id, '你愿意解释21:58听到的门锁声吗？'
    ) as { questionId: string }

    w.scheduler.nudge(roomId, agent.id)
    await w.scheduler.pump(roomId)

    const afterState = w.rooms.requireRoundState(round.id, agent.id)
    assert.equal(afterState.discussionFinished, true)
    const after = w.queries.view(roomId, human.id).players.find(player => player.id === agent.id)!
    assert.equal(after.roundStatus, 'done')
    assert.equal(after.canNudge, undefined)

    const publicCount = w.rooms.listPublicEvents(roomId).length
    w.commands.finishRound(roomId, human.id, randomUUID())
    assert.equal(w.rooms.requireQuestion(roomId, question.questionId).status, 'declined')
    assert.ok(w.rooms.listPublicEvents(roomId).length >= publicCount)
    assert.equal(w.rooms.listPublicEvents(roomId).some(event => event.type === 'question_declined'), false)
  } finally {
    await w.runtime.close()
    w.database.close()
  }
})

test('legacy player round states gain discussion_finished during migration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'murder-mystery-round-state-migration-'))
  const databasePath = join(directory, 'legacy.sqlite')
  try {
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      create table player_round_states (
        round_instance_id text not null,
        room_player_id text not null,
        last_seen_public_version integer not null default 0,
        done_at_public_version integer,
        activation_count integer not null default 0,
        initial_action_done integer not null default 0,
        search_actions_used integer not null default 0,
        search_finished integer not null default 0,
        updated_at text not null,
        primary key(round_instance_id, room_player_id)
      );
    `)
    legacy.close()

    const migrated = new MurderMysteryDatabase(databasePath)
    const columns = migrated.db.prepare('pragma table_info(player_round_states)').all() as Array<{name:string}>
    assert.ok(columns.some(column => column.name === 'discussion_finished'))
    migrated.close()
  } finally {
    rmSync(directory, {recursive:true, force:true})
  }
})

test('legacy clue holdings migrate from room-global to per-player uniqueness', () => {
  const directory = mkdtempSync(join(tmpdir(), 'murder-mystery-migration-'))
  const databasePath = join(directory, 'legacy.sqlite')
  try {
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      create table clue_holdings (
        id text primary key,
        room_id text not null,
        room_player_id text not null,
        clue_id text not null,
        acquired_event_id text not null,
        state text not null,
        revealed_event_id text,
        created_at text not null,
        unique(room_id, clue_id)
      );
    `)
    legacy.close()

    const migrated = new MurderMysteryDatabase(databasePath)
    const row = migrated.db.prepare(
      "select sql from sqlite_master where type='table' and name='clue_holdings'"
    ).get() as {sql: string}
    assert.match(row.sql, /unique\s*\(\s*room_id\s*,\s*room_player_id\s*,\s*clue_id\s*\)/i)
    assert.doesNotMatch(row.sql, /unique\s*\(\s*room_id\s*,\s*clue_id\s*\)/i)
    migrated.close()
  } finally {
    rmSync(directory, {recursive:true, force:true})
  }
})

test('scheduler pacing config reads env values and validates positive integers', () => {
  assert.deepEqual(readSchedulerConfig({}), {
    discussionPacingAfterMinutes:8,
    discussionPacingMessageCount:30,
    discussionPacingActivationCount:45,
  })
  assert.deepEqual(readSchedulerConfig({
    AI_MURDER_MYSTERY_DISCUSSION_PACING_AFTER_MINUTES:'12',
    AI_MURDER_MYSTERY_DISCUSSION_PACING_MESSAGE_COUNT:'40',
    AI_MURDER_MYSTERY_DISCUSSION_PACING_ACTIVATION_COUNT:'60',
  }), {
    discussionPacingAfterMinutes:12,
    discussionPacingMessageCount:40,
    discussionPacingActivationCount:60,
  })
  assert.throws(() => readSchedulerConfig({AI_MURDER_MYSTERY_DISCUSSION_PACING_AFTER_MINUTES:'0'}), /INVALID_AI_MURDER_MYSTERY_DISCUSSION_PACING_AFTER_MINUTES/)
  assert.throws(() => readSchedulerConfig({AI_MURDER_MYSTERY_DISCUSSION_PACING_MESSAGE_COUNT:'1.5'}), /INVALID_AI_MURDER_MYSTERY_DISCUSSION_PACING_MESSAGE_COUNT/)
  assert.throws(() => readSchedulerConfig({AI_MURDER_MYSTERY_DISCUSSION_PACING_ACTIVATION_COUNT:'abc'}), /INVALID_AI_MURDER_MYSTERY_DISCUSSION_PACING_ACTIVATION_COUNT/)
})

test('live mode refuses to silently fall back when model configuration is missing', () => {
  assert.throws(
    () => assertLiveModelConfigured({
      mode: 'live',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      agentDbPath: ':memory:',
    }, {}),
    /MODEL_NOT_CONFIGURED/,
  )
})

async function driveHumanToVote(
  w: ReturnType<typeof createWorld>,
  roomId: string,
  humanId: string,
) {
  for (let guard = 0; guard < 30; guard += 1) {
    await w.scheduler.pump(roomId)
    const room = w.rooms.requireRoom(roomId)
    if (room.status === 'completed') return
    const definition = w.director.definition(roomId)
    if (definition.type === 'vote') return
    const round = w.rooms.getCurrentRound(roomId)!
    const state = w.rooms.requireRoundState(round.id, humanId)

    if (definition.type === 'discussion') {
      if (definition.mode !== 'free' && !w.director.isOrderedTurn(roomId, humanId)) continue
      const latest = w.rooms.requireRoom(roomId).sharedVersion
      if (definition.mode === 'ordered' && !state.initialActionDone) {
        w.commands.sendMessage(roomId, humanId, randomUUID(), '真人完成当前顺序发言。')
      } else if (state.doneAtPublicVersion === null || state.doneAtPublicVersion < latest) {
        w.commands.finishRound(roomId, humanId, randomUUID())
      }
      continue
    }

    if (definition.type === 'search' && !state.searchFinished) {
      if (state.searchActionsUsed < definition.actionsPerPlayer) {
        const script = w.scripts.getByVersionId(room.scriptVersionId)!
        const ownedByHuman = new Set(
          w.rooms.listHoldings(roomId)
            .filter(item => item.roomPlayerId === humanId)
            .map(item => item.clueId)
        )
        const clue = script.clues.find(item => item.roundId === definition.id && !ownedByHuman.has(item.id))
        if (clue) {
          const result = w.commands.searchClue(
            roomId, humanId, randomUUID(), clue.locationId
          ) as { holdingId: string }
          const holding = w.rooms.requireHolding(roomId, result.holdingId)
          if (holding.state === 'private') {
            w.commands.revealClue(roomId, humanId, randomUUID(), holding.id)
          }
        }
      }
      w.commands.finishSearch(roomId, humanId, randomUUID())
    }
  }
  throw new Error('E2E_GUARD_EXCEEDED')
}
