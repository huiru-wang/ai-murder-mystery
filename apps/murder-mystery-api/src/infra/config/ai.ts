export type MurderMysteryAiConfig = {
  mode: 'live' | 'mock'
  provider: string
  model: string
  agentDbPath: string
}

export function readAiConfig(env:NodeJS.ProcessEnv=process.env):MurderMysteryAiConfig {
  const mode=(env.AI_MURDER_MYSTERY_AI_MODE??'live') as 'live'|'mock'
  if(mode!=='live'&&mode!=='mock') throw new Error('INVALID_AI_MURDER_MYSTERY_AI_MODE')
  return {
    mode,
    provider:env.AI_MURDER_MYSTERY_MODEL_PROVIDER??'deepseek',
    model:env.AI_MURDER_MYSTERY_MODEL_NAME??'deepseek-v4-pro',
    agentDbPath:env.AI_MURDER_MYSTERY_AGENT_DB??'data/agent.sqlite',
  }
}

export function assertLiveModelConfigured(config:MurderMysteryAiConfig,env:NodeJS.ProcessEnv=process.env) {
  if(config.mode==='mock') return
  const keyName=`${config.provider.toUpperCase().replace(/[^A-Z0-9]/g,'_')}_API_KEY`
  if(!env[keyName]?.trim()) throw new Error('MODEL_NOT_CONFIGURED')
}


export type MurderMysterySchedulerConfig = {
  discussionPacingAfterMinutes: number
  discussionPacingMessageCount: number
  discussionPacingActivationCount: number
}

function positiveInteger(env:NodeJS.ProcessEnv,name:string,fallback:number):number {
  const raw=env[name]
  if(raw===undefined||raw.trim()==='') return fallback
  const value=Number(raw)
  if(!Number.isInteger(value)||value<1) throw new Error(`INVALID_${name}`)
  return value
}

export function readSchedulerConfig(env:NodeJS.ProcessEnv=process.env):MurderMysterySchedulerConfig {
  return {
    discussionPacingAfterMinutes:positiveInteger(env,'AI_MURDER_MYSTERY_DISCUSSION_PACING_AFTER_MINUTES',8),
    discussionPacingMessageCount:positiveInteger(env,'AI_MURDER_MYSTERY_DISCUSSION_PACING_MESSAGE_COUNT',30),
    discussionPacingActivationCount:positiveInteger(env,'AI_MURDER_MYSTERY_DISCUSSION_PACING_ACTIVATION_COUNT',45),
  }
}
