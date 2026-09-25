export type AgentTriggerType =
  | 'round_started'
  | 'scheduled_opportunity'
  | 'direct_question'
  | 'public_state_changed'
  | 'search_turn'
  | 'vote_requested'
  | 'nudge'

export interface AgentTrigger {
  type: AgentTriggerType
  roomId: string
  playerId: string
  sourceEventId?: string
  fromPlayerId?: string
  questionId?: string
  directedToYou: boolean
}
