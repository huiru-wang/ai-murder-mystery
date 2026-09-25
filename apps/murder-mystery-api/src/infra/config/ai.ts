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
