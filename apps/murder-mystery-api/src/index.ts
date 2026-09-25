import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { MurderMysteryDatabase } from './infra/sqlite/database.js'
import { readAiConfig, readSchedulerConfig } from './infra/config/ai.js'
import { ScriptRepository } from './domain/script/repository.js'
import { RoomRepository } from './domain/room/repository.js'
import { GameDirector } from './domain/round/director.js'
import { RoomCommandService } from './domain/room/commands.js'
import { RoomQueryService } from './domain/room/queries.js'
import { PlayerAgentContextBuilder } from './runtime/player-agent/context-builder.js'
import { LivePlayerAgentRuntime, MockPlayerAgentRuntime } from './runtime/player-agent/runtime.js'
import { RoomScheduler } from './runtime/scheduler/room-scheduler.js'
import { createApp } from './http/app.js'

const appRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const projectRoot=resolve(appRoot,'../..')
const absolute=(value:string|undefined,fallback:string)=>{
  const raw=value??fallback
  return isAbsolute(raw)?raw:resolve(projectRoot,raw)
}

const database=new MurderMysteryDatabase(absolute(process.env.AI_MURDER_MYSTERY_SQLITE_PATH,'data/game.sqlite'))
const scripts=new ScriptRepository()
const rooms=new RoomRepository(database)
const director=new GameDirector(rooms,scripts)
const commands=new RoomCommandService(rooms,scripts,director)
const queries=new RoomQueryService(rooms,scripts,director)
const contextBuilder=new PlayerAgentContextBuilder(rooms,scripts,director)

const config=readAiConfig()
config.agentDbPath=absolute(process.env.AI_MURDER_MYSTERY_AGENT_DB,'data/agent.sqlite')
const runtime=config.mode==='mock'
  ? new MockPlayerAgentRuntime(rooms,scripts,director,commands)
  : new LivePlayerAgentRuntime(config,rooms,commands,contextBuilder,director)
const schedulerConfig=readSchedulerConfig()
const scheduler=new RoomScheduler(rooms,director,runtime,schedulerConfig)
const app=createApp({rooms,commands,queries,runtime,scheduler})

runtime.assertReady()

const port=Number(process.env.AI_MURDER_MYSTERY_API_PORT??3200)
if(!Number.isInteger(port)||port<1||port>65535) throw new Error('INVALID_PORT')
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port},info=>{
  console.log(`MurderMystery V2 API listening on http://127.0.0.1:${info.port}; aiMode=${config.mode}; model=${config.provider}/${config.model}`)
  scheduler.resumeActiveRooms()
})

for(const signal of ['SIGINT','SIGTERM'] as const) {
  process.once(signal,()=>{
    server.close(()=>{
      void runtime.close().finally(()=>{
        database.close()
        process.exit(0)
      })
    })
    setTimeout(()=>process.exit(1),10_000).unref()
  })
}
