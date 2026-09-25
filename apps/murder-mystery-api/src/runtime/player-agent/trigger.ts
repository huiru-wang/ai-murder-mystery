export type AgentTriggerType =
  | 'round_started'
  | 'scheduled_opportunity'
  | 'direct_question'
  | 'public_state_changed'
  | 'search_turn'
  | 'vote_requested'
  | 'nudge'

export interface DiscussionPacing {
  level: 'within_limit' | 'should_wrap_up'
  elapsedMinutes: number
  publicMessageCount: number
  activationCount: number
  finishedPlayerCount: number
  totalPlayerCount: number
  limitMinutes: number
  limitPublicMessages: number
  limitAgentActivations: number
}

export interface AgentTrigger {
  type: AgentTriggerType
  roomId: string
  playerId: string
  sourceEventId?: string
  fromPlayerId?: string
  questionId?: string
  directedToYou: boolean
  pacing?: DiscussionPacing
}
