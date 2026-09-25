import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { RoomCommandService } from '../src/domain/room/commands.js'
import { RoomQueryService } from '../src/domain/room/queries.js'
import { RoomRepository } from '../src/domain/room/repository.js'
import { GameDirector, shuffledTurnOrder } from '../src/domain/round/director.js'
import { ScriptRepository } from '../src/domain/script/repository.js'
import { assertLiveModelConfigured } from '../src/infra/config/ai.js'
import { MurderMysteryDatabase } from '../src/infra/sqlite/database.js'
import { PlayerAgentContextBuilder } from '../src/runtime/player-agent/context-builder.js'
import { MockPlayerAgentRuntime } from '../src/runtime/player-agent/runtime.js'
import { RoomScheduler } from '../src/runtime/scheduler/room-scheduler.js'

function createWorld() {
  const database = new MurderMysteryDatabase(':memory:')
  const scripts = new ScriptRepository()
  const rooms = new RoomRepository(database)
  const director = new GameDirector(rooms, scripts)
  const commands = new RoomCommandService(rooms, scripts, director)
  const queries = new RoomQueryService(rooms, scripts, director)
  const contextBuilder = new PlayerAgentContextBuilder(rooms, scripts, director)
  const runtime = new MockPlayerAgentRuntime(rooms, scripts, director, commands)
  const scheduler = new RoomScheduler(rooms, director, runtime)
  return { database, scripts, rooms, director, commands, queries, contextBuilder, runtime, scheduler }
}

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
  assert.equal(w.director.definition(roomId).id, 'introduction')
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

test('private clue stays isolated until reveal and public version invalidates stale finish', async () => {
  const w = createWorld()
  try {
    const { roomId, human } = startOneHuman(w)
    const players = w.rooms.listPlayers(roomId)

    await finishIntroduction(w, roomId, human.id)
    assert.equal(w.director.definition(roomId).id, 'discussion-1')

    w.commands.finishRound(roomId, human.id, randomUUID())
    const discussion = w.rooms.getCurrentRound(roomId)!
    const finishedAt = w.rooms.requireRoundState(discussion.id, human.id).doneAtPublicVersion!
    const shen = players.find(player => player.roleId === 'shen-yan')!
    w.commands.sendMessage(roomId, shen.id, randomUUID(), '我补充一个新的公开信息。')
    const latestVersion = w.rooms.requireRoom(roomId).sharedVersion
    assert.ok(latestVersion > finishedAt)
    assert.ok(w.rooms.requireRoundState(discussion.id, human.id).doneAtPublicVersion! < latestVersion)

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
    assert.equal(w.director.definition(roomId).id, 'introduction')
    assert.throws(() => w.commands.finishRound(roomId, human.id, randomUUID()), /TOOL_NOT_ALLOWED_IN_ROUND/)
    assert.throws(() => w.commands.yieldTurn(roomId, human.id, randomUUID()), /TOOL_NOT_ALLOWED_IN_ROUND/)

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

    w.scheduler.nudge(roomId, agent.id)
    await w.scheduler.pump(roomId)

    const afterState = w.rooms.requireRoundState(round.id, agent.id)
    assert.equal(afterState.doneAtPublicVersion, w.rooms.requireRoom(roomId).sharedVersion)
    const after = w.queries.view(roomId, human.id).players.find(player => player.id === agent.id)!
    assert.equal(after.roundStatus, 'done')
    assert.equal(after.canNudge, undefined)

    const zhou = w.rooms.listPlayers(roomId).find(player => player.roleId === 'zhou-qi')!
    const question = w.commands.askPlayer(
      roomId, zhou.id, randomUUID(), human.id, '你愿意解释21:58听到的门锁声吗？'
    ) as { questionId: string }
    const publicCount = w.rooms.listPublicEvents(roomId).length
    w.commands.finishRound(roomId, human.id, randomUUID())
    assert.equal(w.rooms.requireQuestion(roomId, question.questionId).status, 'declined')
    assert.equal(w.rooms.listPublicEvents(roomId).length, publicCount)
    assert.equal(w.rooms.listPublicEvents(roomId).some(event => event.type === 'question_declined'), false)
  } finally {
    await w.runtime.close()
    w.database.close()
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
