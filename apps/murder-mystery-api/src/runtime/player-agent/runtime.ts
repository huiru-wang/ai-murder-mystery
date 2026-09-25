import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  AgentHarness,
  TODO_CONTEXT,
  type AgentHarness as AgentHarnessType,
  type AgentLane,
  type ExecutionToolContext,
  type Session,
} from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { createNodeSqliteFactory, SqliteSessionRepo } from '@earendil-works/pi-session-backend-sqlite-node'
import { RoomRepository } from '../../domain/room/repository.js'
import { RoomCommandService } from '../../domain/room/commands.js'
import { GameDirector } from '../../domain/round/director.js'
import { ScriptRepository } from '../../domain/script/repository.js'
import { assertLiveModelConfigured, type MurderMysteryAiConfig } from '../../infra/config/ai.js'
import { PlayerAgentContextBuilder } from './context-builder.js'
import type { AgentTrigger } from './trigger.js'
import { createPlayerTools } from './tools/index.js'

export interface PlayerAgentRuntime {
  assertReady():void
  ensureRoomSessions(roomId:string):Promise<void>
  run(trigger:AgentTrigger):Promise<void>
  close():Promise<void>
}

type ManagedSession = {
  runtimeSessionId:string
  bindingId:string
  session:Session
  harness:AgentHarnessType<ExecutionToolContext>
  lane:AgentLane
}

export class LivePlayerAgentRuntime implements PlayerAgentRuntime {
  private readonly models=builtinModels()
  private readonly sessionRepo:SqliteSessionRepo
  private readonly cache=new Map<string,ManagedSession>()
  private readonly revision:string

  constructor(
    private readonly config:MurderMysteryAiConfig,
    private readonly rooms:RoomRepository,
    private readonly commands:RoomCommandService,
    private readonly contextBuilder:PlayerAgentContextBuilder,
    private readonly director:GameDirector,
  ) {
    mkdirSync(dirname(config.agentDbPath),{recursive:true})
    this.sessionRepo=new SqliteSessionRepo({
      directory:dirname(config.agentDbPath),
      databasePath:config.agentDbPath,
      databaseFactory:createNodeSqliteFactory(),
    })
    this.revision=`v2:${config.provider}/${config.model}`
  }

  assertReady() {
    assertLiveModelConfigured(this.config)
    if(!this.models.getModel(this.config.provider,this.config.model)) throw new Error('MODEL_NOT_IN_CATALOG')
  }

  async ensureRoomSessions(roomId:string) {
    const agents=this.rooms.listPlayers(roomId).filter(player=>player.controller==='agent')
    if(!agents.length) return
    this.assertReady()
    for(const player of agents) await this.ensureSession(roomId,player.id)
  }

  async run(trigger:AgentTrigger) {
    this.assertReady()
    const managed=await this.ensureSession(trigger.roomId,trigger.playerId)
    const context=this.contextBuilder.build(trigger.roomId,trigger.playerId,trigger)
    const definition=this.director.definition(trigger.roomId)
    const roundAtStart=this.rooms.getCurrentRound(trigger.roomId)
    if(!roundAtStart) throw new Error('NO_ACTIVE_ROUND')
    if(definition.type==='search') {
      const state=this.rooms.requireRoundState(roundAtStart.id,trigger.playerId)
      if(!state.searchFinished&&state.searchActionsUsed>=definition.actionsPerPlayer) {
        this.commands.finishSearch(trigger.roomId,trigger.playerId,randomUUID())
        return
      }
    }
    await managed.lane.setActiveTools(definition.allowedTools,TODO_CONTEXT)
    let toolCount=0
    let terminalCalled=false
    const terminalTools=new Set(['finish_round','yield_turn','finish_search','submit_vote'])
    if(definition.id==='introduction') terminalTools.add('send_message')
    const unsubscribe=managed.harness.hooks.on('before_tool',({toolName})=>{
      if(terminalCalled) return {block:{reason:'This activation already ended with a terminal game action',terminate:true}}
      toolCount+=1
      if(toolCount>4) return {block:{reason:'Maximum tool calls reached for this activation',terminate:true}}
      if(terminalTools.has(toolName)) terminalCalled=true
      return undefined
    })

    const runId=this.rooms.createAgentRun({
      agentSessionId:managed.bindingId,
      roundInstanceId:this.rooms.requireRoom(trigger.roomId).currentRoundInstanceId,
      triggerType:trigger.type,
      triggerEventId:trigger.sourceEventId??null,
    })
    try {
      const result=await managed.lane.prompt(context.dynamicPrompt,undefined,TODO_CONTEXT)
      const modelCompleted=result.ok&&result.value.status==='completed'
      let searchResolved=false
      if(definition.type==='search') {
        const active=this.rooms.getCurrentRound(trigger.roomId)
        if(!active||active.id!==roundAtStart.id) {
          searchResolved=true
        } else {
          const state=this.rooms.requireRoundState(roundAtStart.id,trigger.playerId)
          if(!state.searchFinished&&state.searchActionsUsed>=definition.actionsPerPlayer) {
            this.commands.finishSearch(trigger.roomId,trigger.playerId,randomUUID())
          }
          const latestRound=this.rooms.getCurrentRound(trigger.roomId)
          searchResolved=latestRound?.id!==roundAtStart.id
            || this.rooms.requireRoundState(roundAtStart.id,trigger.playerId).searchFinished
        }
      }
      let introductionResolved=false
      if(definition.id==='introduction'&&modelCompleted) {
        let active=this.rooms.getCurrentRound(trigger.roomId)
        introductionResolved=active?.id!==roundAtStart.id
          || this.rooms.requireRoundState(roundAtStart.id,trigger.playerId).initialActionDone
        if(!introductionResolved&&toolCount===0) {
          this.commands.sendMessage(trigger.roomId,trigger.playerId,randomUUID(),context.introductionText)
          toolCount=1
          active=this.rooms.getCurrentRound(trigger.roomId)
          introductionResolved=active?.id!==roundAtStart.id
            || this.rooms.requireRoundState(roundAtStart.id,trigger.playerId).initialActionDone
        }
      }
      let discussionResolved=false
      if(definition.type==='discussion'&&definition.mode==='free'&&toolCount===0&&modelCompleted) {
        if(trigger.type==='round_started') {
          await managed.lane.prompt(
            '你刚才没有执行任何游戏动作。这是本轮自由讨论中你的首次参与机会。必须调用一个可用工具完成一次公开参与，优先调用 send_message 发表一个与当前案件有关的观点或问题。不要只输出普通文本。',
            undefined,
            TODO_CONTEXT,
          )
          if(toolCount===0) {
            this.commands.sendMessage(trigger.roomId,trigger.playerId,randomUUID(),context.discussionFallbackText)
            toolCount=1
          }
        } else if(trigger.type==='direct_question'&&trigger.questionId) {
          await managed.lane.prompt(
            `你刚才没有回应被点名的问题。必须调用 reply_question 或 decline_question 处理 questionId=${trigger.questionId}，不要只输出普通文本。`,
            undefined,
            TODO_CONTEXT,
          )
          if(toolCount===0) {
            this.commands.declineQuestion(trigger.roomId,trigger.playerId,randomUUID(),trigger.questionId)
            toolCount=1
          }
        } else {
          this.commands.finishRound(trigger.roomId,trigger.playerId,randomUUID())
          toolCount=1
        }
        const active=this.rooms.getCurrentRound(trigger.roomId)
        discussionResolved=active?.id!==roundAtStart.id
          || this.rooms.requireRoundState(roundAtStart.id,trigger.playerId).activationCount>0
      }
      const activationResolved=searchResolved||introductionResolved||discussionResolved
      if(!modelCompleted&&!activationResolved) throw new Error('AGENT_RUN_FAILED')
      if(toolCount===0&&!activationResolved) throw new Error('AGENT_NO_TOOL_ACTION')
      this.rooms.completeAgentRun(runId,'completed',toolCount)
      this.rooms.touchAgentSession(managed.bindingId)
    } catch(error) {
      this.rooms.completeAgentRun(runId,'failed',toolCount)
      throw error
    } finally {
      unsubscribe()
    }
  }

  async close() {
    await Promise.all([...this.cache.values()].map(item=>item.harness.close(TODO_CONTEXT)))
    this.cache.clear()
    await this.sessionRepo.close(TODO_CONTEXT)
  }

  private async ensureSession(roomId:string,playerId:string):Promise<ManagedSession> {
    const cached=this.cache.get(playerId)
    if(cached) return cached

    let binding=this.rooms.getAgentSessionBinding(roomId,playerId)
    let session:Session
    let runtimeSessionId:string

    if(binding) {
      runtimeSessionId=binding.runtimeSessionId
      const metadata=(await this.sessionRepo.list(undefined,TODO_CONTEXT)).find(item=>item.id===runtimeSessionId)
      if(metadata&&binding.agentRevision===this.revision) {
        session=await this.sessionRepo.open(metadata,TODO_CONTEXT)
      } else {
        runtimeSessionId=randomUUID()
        session=await this.sessionRepo.create({id:runtimeSessionId},TODO_CONTEXT)
        this.rooms.replaceAgentSessionBinding({
          bindingId:binding.id,roomId,playerId,runtimeSessionId,agentRevision:this.revision,
        })
        binding={...binding,runtimeSessionId,agentRevision:this.revision}
      }
    } else {
      runtimeSessionId=randomUUID()
      session=await this.sessionRepo.create({id:runtimeSessionId},TODO_CONTEXT)
      const bindingId=this.rooms.createAgentSessionBinding({
        roomId,playerId,runtimeSessionId,agentRevision:this.revision,
      })
      binding={id:bindingId,runtimeSessionId,agentRevision:this.revision}
    }

    try {
      const bootstrapTrigger:AgentTrigger={
        type:'round_started',roomId,playerId,directedToYou:false,
      }
      const context=this.contextBuilder.build(roomId,playerId,bootstrapTrigger)
      const model=this.models.getModel(this.config.provider,this.config.model)
      if(!model) throw new Error('MODEL_NOT_IN_CATALOG')
      const tools=createPlayerTools(this.commands,roomId,playerId)
      const {harness}=await AgentHarness.create<ExecutionToolContext>({
        session,
        models:this.models,
        model,
        systemPrompt:context.systemPrompt,
        tools,
        activeToolNames:tools.map(tool=>tool.name),
        toolContext:{env:new NodeExecutionEnv({cwd:process.cwd(),shellEnv:{}})},
        resources:{skills:[]},
        compaction:{enabled:true,reserveTokens:8192,keepRecentTokens:12000},
        streamOptions:{timeoutMs:120_000,maxRetries:0},
      },TODO_CONTEXT)
      const lane=await harness.lane('main',{createAt:null},TODO_CONTEXT)
      await lane.setModel({provider:this.config.provider,modelId:this.config.model},TODO_CONTEXT)
      await lane.setActiveTools(tools.map(tool=>tool.name),TODO_CONTEXT)
      const managed={runtimeSessionId,bindingId:binding.id,session,harness,lane}
      this.cache.set(playerId,managed)
      return managed
    } catch(error) {
      await session.close(TODO_CONTEXT)
      throw error
    }
  }
}

export class MockPlayerAgentRuntime implements PlayerAgentRuntime {
  constructor(
    private readonly rooms:RoomRepository,
    private readonly scripts:ScriptRepository,
    private readonly director:GameDirector,
    private readonly commands:RoomCommandService,
  ) {}

  assertReady() {}

  async ensureRoomSessions(roomId:string) {
    for(const player of this.rooms.listPlayers(roomId).filter(item=>item.controller==='agent')) {
      if(this.rooms.getAgentSessionBinding(roomId,player.id)) continue
      this.rooms.createAgentSessionBinding({
        roomId,playerId:player.id,runtimeSessionId:`mock-${randomUUID()}`,agentRevision:'mock-v2',
      })
    }
  }

  async run(trigger:AgentTrigger) {
    const room=this.rooms.requireRoom(trigger.roomId)
    const player=this.rooms.requirePlayer(trigger.roomId,trigger.playerId)
    if(player.controller!=='agent'||!player.roleId) throw new Error('NOT_AGENT_PLAYER')
    const round=this.rooms.getCurrentRound(trigger.roomId)
    if(!round) throw new Error('NO_ACTIVE_ROUND')
    const definition=this.director.definition(trigger.roomId)
    const script=this.scripts.getByVersionId(room.scriptVersionId)!
    const role=script.roles.find(item=>item.id===player.roleId)!
    const state=this.rooms.requireRoundState(round.id,player.id)

    if(definition.type==='discussion') {
      const pending=this.rooms.listPendingQuestions(trigger.roomId).find(question=>question.toPlayerId===player.id)
      if(pending) {
        const fact=role.knownFacts[0]??'我现在能确认的信息不多。'
        this.commands.replyQuestion(
          trigger.roomId,player.id,randomUUID(),pending.id,
          `针对你的问题，我目前能确认的是：${fact}`,
        )
      } else if(state.activationCount===0) {
        const message=definition.id==='introduction'
          ? `我是${role.name}，${role.occupation}。${role.publicProfile}`
          : `${role.knownFacts[0]??'我先根据目前公开信息继续观察。'}`
        this.commands.sendMessage(trigger.roomId,player.id,randomUUID(),message)
      }
      if(definition.mode==='free') {
        this.commands.finishRound(trigger.roomId,player.id,randomUUID())
      }
      return
    }

    if(definition.type==='search') {
      const holdings=this.rooms.listHoldings(trigger.roomId)
      const ownedByPlayer=new Set(
        holdings.filter(item=>item.roomPlayerId===player.id).map(item=>item.clueId)
      )
      const clue=script.clues.find(item=>item.roundId===definition.id&&!ownedByPlayer.has(item.id))
      if(clue&&state.searchActionsUsed<definition.actionsPerPlayer) {
        const result=this.commands.searchClue(trigger.roomId,player.id,randomUUID(),clue.locationId) as {holdingId:string}
        const holding=this.rooms.requireHolding(trigger.roomId,result.holdingId)
        const shouldHide=role.id==='he-chuan'&&['key','fiber','draft','power-question'].includes(holding.clueId)
        if(holding.state==='private') {
          if(shouldHide) this.commands.keepCluePrivate(trigger.roomId,player.id,randomUUID(),holding.id)
          else this.commands.revealClue(trigger.roomId,player.id,randomUUID(),holding.id)
        }
      }
      const latest=this.rooms.requireRoundState(round.id,player.id)
      if(latest.searchActionsUsed>=definition.actionsPerPlayer||!clue) {
        this.commands.finishSearch(trigger.roomId,player.id,randomUUID())
      }
      return
    }

    if(definition.type==='vote') {
      const target=role.id==='he-chuan'?'shen-yan':'he-chuan'
      this.commands.submitVote(trigger.roomId,player.id,randomUUID(),target,'mock vote')
    }
  }

  async close() {}
}
