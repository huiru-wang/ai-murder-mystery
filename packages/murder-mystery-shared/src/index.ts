export type PlayerController = 'human' | 'agent'
export type RoomStatus = 'lobby' | 'running' | 'voting' | 'completed' | 'aborted'
export type EventVisibility = 'public' | 'private' | 'control' | 'sealed'
export type RoundType = 'discussion' | 'search' | 'vote' | 'reveal'
export type DiscussionMode = 'ordered' | 'free' | 'ordered_opportunity_then_free'
export type PlayerRoundStatus =
  | 'waiting'
  | 'current'
  | 'done'
  | 'needs_confirmation'
  | 'searching'
  | 'search_done'
  | 'voted'

export type GameToolName =
  | 'send_message'
  | 'ask_player'
  | 'reply_question'
  | 'decline_question'
  | 'yield_turn'
  | 'finish_round'
  | 'pass'
  | 'search_clue'
  | 'reveal_clue'
  | 'keep_clue_private'
  | 'finish_search'
  | 'submit_vote'

export type RoomEventType =
  | 'room_started'
  | 'round_started'
  | 'message_sent'
  | 'question_asked'
  | 'question_replied'
  | 'question_declined'
  | 'clue_acquired'
  | 'clue_revealed'
  | 'round_finished'
  | 'discussion_pacing_reminder'
  | 'vote_submitted'
  | 'round_completed'
  | 'game_completed'

export interface ScriptSummary {
  id: string
  version: string
  title: string
  description: string
  playerCount: number
  publicContext?: string
}

export interface LocationView {
  id: string
  name: string
  description: string
}

export interface RoleCard {
  id: string
  name: string
  age: number
  gender: string
  occupation: string
  publicProfile: string
  selectedByPlayerId?: string
}

export interface PlayerPrivateView {
  roleId: string
  name: string
  privateStory: string
  knownFacts: string[]
  secrets: string[]
  goals: string[]
  relationships: string[]
}

export interface RoomPlayerView {
  id: string
  seatNo: number
  roleId: string | null
  roleName: string | null
  controller: PlayerController
  displayName: string
  status: string
  roundStatus?: PlayerRoundStatus
  canNudge?: boolean
}

export interface PublicTimelineEvent {
  id: string
  seq: number
  type: RoomEventType
  actorPlayerId: string | null
  actorName: string | null
  targetPlayerId: string | null
  targetName: string | null
  payload: Record<string, unknown>
  createdAt: string
}

export interface ClueView {
  holdingId: string
  clueId: string
  title: string
  content: string
  locationId: string
  ownerPlayerId: string
  state: 'private' | 'public'
}

export interface PendingQuestionView {
  id: string
  sourceEventId: string
  fromPlayerId: string
  fromName: string
  toPlayerId: string
  toName: string
  question: string
  status: 'pending' | 'answered' | 'declined'
}

export interface CurrentRoundView {
  id: string
  definitionId: string
  title: string
  type: RoundType
  mode?: DiscussionMode
  requiredAction?: 'introduce'
  index: number
  status: 'active' | 'completed'
  sharedVersionAtStart: number
  actionsPerPlayer?: number
}

export interface RoundPlanItem {
  id: string
  title: string
  type: RoundType
  mode?: DiscussionMode
  index: number
}

export interface ReviewRoleView extends PlayerPrivateView {
  age: number
  gender: string
  occupation: string
  publicProfile: string
}

export interface ReviewClueView {
  clueId: string
  title: string
  content: string
  locationId: string
  status: 'public' | 'kept_private' | 'undiscovered'
  ownerPlayerId: string | null
  ownerName: string | null
}

export type AvailableAction =
  | 'SELECT_ROLE'
  | 'START_GAME'
  | 'SEND_MESSAGE'
  | 'ASK_PLAYER'
  | 'REPLY_QUESTION'
  | 'DECLINE_QUESTION'
  | 'FINISH_ROUND'
  | 'SEARCH_CLUE'
  | 'REVEAL_CLUE'
  | 'KEEP_CLUE_PRIVATE'
  | 'FINISH_SEARCH'
  | 'SUBMIT_VOTE'

export interface RoomView {
  id: string
  script: ScriptSummary
  status: RoomStatus
  sharedVersion: number
  players: RoomPlayerView[]
  me: RoomPlayerView | null
  currentRound: CurrentRoundView | null
  availableActions: AvailableAction[]
  publicTimeline: PublicTimelineEvent[]
  publicClues: ClueView[]
  privateClues: ClueView[]
  pendingQuestionsForMe: PendingQuestionView[]
  locations: LocationView[]
  publicRoles: RoleCard[]
  roundPlan: RoundPlanItem[]
  roleCards?: RoleCard[]
  privateRole?: PlayerPrivateView
  result?: {
    murdererRoleId: string
    murdererName: string
    truth: string
    votes: Array<{ playerId: string; playerName: string; targetRoleId: string; targetName: string }>
  }
  review?: {
    roles: ReviewRoleView[]
    clues: ReviewClueView[]
  }
}

export interface CreateRoomRequest {
  scriptId: string
  humanCount?: number
}

export interface SelectRoleRequest {
  playerId: string
  roleId: string
}

export interface MessageActionRequest {
  playerId: string
  commandId: string
  content: string
}

export interface QuestionActionRequest {
  playerId: string
  commandId: string
  targetPlayerId: string
  question: string
}

export interface ReplyQuestionRequest {
  playerId: string
  commandId: string
  questionId: string
  content: string
}

export interface QuestionDecisionRequest {
  playerId: string
  commandId: string
  questionId: string
}

export interface FinishRoundRequest {
  playerId: string
  commandId: string
}

export interface NudgePlayerRequest {
  playerId: string
  targetPlayerId: string
}

export interface SearchActionRequest {
  playerId: string
  commandId: string
  locationId: string
}

export interface ClueDecisionRequest {
  playerId: string
  commandId: string
  holdingId: string
}

export interface VoteActionRequest {
  playerId: string
  commandId: string
  targetRoleId: string
  reasoning?: string
}
