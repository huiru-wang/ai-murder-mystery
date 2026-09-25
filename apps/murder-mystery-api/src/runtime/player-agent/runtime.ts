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
import { assertModelConfigured, type MurderMysteryAiConfig } from '../../infra/config/ai.js'
import { PlayerAgentContextBuilder } from './context-builder.js'
import type { AgentTrigger } from './trigger.js'
import { createPlayerTools } from './tools/index.js'

export interface PlayerAgentRuntime {
  assertReady():void
  ensureRoomSessions(roomId:string):Promise<void>
  run(trigger:AgentTrigger):Promise<void>
  abortRoom(roomId:string):Promise<void>
  close():Promise<void>
}

type ManagedSession = {
  roomId:string
  playerId:string
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
    this.revision=`v4:${config.provider}/${config.model}`
  }

  assertReady() {
    assertModelConfigured(this.config)
    if(!this.models.getModel(this.config.provider,this.config.model)) {
      throw new Error(`MODEL_NOT_IN_CATALOG: ${this.config.provider}/${this.config.model}`)
    }
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
    const agentAllowedTools=trigger.type==='nudge'
      ? definition.allowedTools.filter(tool=>tool!=='pass')
      : definition.allowedTools
    await managed.lane.setActiveTools(agentAllowedTools,TODO_CONTEXT)
    let toolCount=0
    let terminalCalled=false
    const terminalTools=new Set(['pass','finish_round','yield_turn','finish_search','submit_vote'])
    if(definition.type==='discussion'&&definition.requiredAction==='introduce') terminalTools.add('send_message')
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
      let result=await managed.lane.prompt(context.dynamicPrompt,undefined,TODO_CONTEXT)
      let modelCompleted=result.ok&&result.value.status==='completed'
      if(modelCompleted&&toolCount===0&&definition.type==='discussion'&&definition.mode==='free') {
        const recoveryPrompt=trigger.type==='direct_question'&&trigger.questionId
          ? `你上一条只输出了普通文本，因此没有执行任何游戏动作，其他玩家也看不到那段文字。现在必须调用 reply_question 或 decline_question 处理 questionId=${trigger.questionId}。不要再输出普通文本。`
          : trigger.type==='nudge'
            ? '你正在被真人催促结束本轮。上一条只输出普通文本，不算有效行动。现在只有两种选择：如果还有新的关键内容，立即调用 send_message 或 ask_player；如果没有，立即调用 finish_round。不要调用 pass，不要再输出普通文本。'
            : '你上一条只输出了普通文本，因此没有执行任何游戏动作，其他玩家也看不到那段文字。请把刚才的真实意图转换成一个工具调用：想公开表达就调用 send_message；想定向提问就调用 ask_player；当前不想说就调用 pass；确定退出本轮才调用 finish_round。必须调用工具，不要再输出普通文本。'
        result=await managed.lane.prompt(recoveryPrompt,undefined,TODO_CONTEXT)
        modelCompleted=result.ok&&result.value.status==='completed'
        if(modelCompleted&&toolCount===0&&trigger.type!=='direct_question') {
          if(trigger.type==='nudge') this.commands.finishRound(trigger.roomId,trigger.playerId,randomUUID())
          else this.commands.pass(trigger.roomId,trigger.playerId,randomUUID())
          toolCount=1
        }
      }
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
      if(definition.type==='discussion'&&definition.requiredAction==='introduce'&&modelCompleted) {
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
      const discussionResolved=false
      const activationResolved=searchResolved||introductionResolved||discussionResolved
      if(!modelCompleted&&!activationResolved) {
        const detail=result.ok
          ? result.value.status==='suspended'
            ? 'status=suspended'
            : result.value.error?.message ?? `status=${result.value.status}`
          : result.error.message
        throw new Error(`AGENT_RUN_FAILED: ${detail}`)
      }
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

  async abortRoom(roomId:string) {
    const managed=[...this.cache.values()].filter(item=>item.roomId===roomId)
    await Promise.all(managed.map(async item=>{
      try { await item.lane.abort(TODO_CONTEXT) } catch {}
      try { await item.harness.close(TODO_CONTEXT) } catch {}
      this.cache.delete(item.playerId)
    }))
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
      const managed={roomId,playerId,runtimeSessionId,bindingId:binding.id,session,harness,lane}
      this.cache.set(playerId,managed)
      return managed
    } catch(error) {
      await session.close(TODO_CONTEXT)
      throw error
    }
  }
}
