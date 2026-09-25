import type { DiscussionMode, EventVisibility, GameToolName, PlayerController, RoomEventType, RoomStatus, RoundType } from '@ai-murder-mystery/shared'

export interface ScriptDefinition {
  id: string
  version: string
  title: string
  description: string
  publicContext: string
  roles: RoleDefinition[]
  locations: LocationDefinition[]
  clues: ClueDefinition[]
  rounds: RoundDefinition[]
  truth: {
    murdererRoleId: string
    content: string
  }
}

export interface RoleDefinition {
  id: string
  name: string
  age: number
  gender: string
  occupation: string
  publicProfile: string
  privateStory: string
  knownFacts: string[]
  secrets: string[]
  goals: string[]
  relationships: string[]
  deceptionPolicy: {
    mayHideOwnFacts: boolean
    mayLieAboutOwnActions: boolean
    forbiddenWorldFabrication: boolean
  }
}

export interface LocationDefinition {
  id: string
  name: string
  description: string
}

export type RoundDefinition =
  | {
      id: string
      type: 'discussion'
      mode: DiscussionMode
      allowedTools: GameToolName[]
    }
  | {
      id: string
      type: 'search'
      actionsPerPlayer: number
      allowedTools: GameToolName[]
    }
  | {
      id: string
      type: 'vote'
      allowedTools: ['submit_vote']
    }
  | {
      id: string
      type: 'reveal'
      allowedTools: []
    }

export interface ClueDefinition {
  id: string
  title: string
  roundId: string
  locationId: string
  content: string
  revealPolicy: 'forced_public' | 'owner_decides' | 'private'
}

export interface RoomRecord {
  id: string
  scriptVersionId: string
  status: RoomStatus
  currentRoundInstanceId: string | null
  sharedVersion: number
  lastEventSeq: number
  runtimeRevision: string
  createdAt: string
  updatedAt: string
}

export interface RoomPlayerRecord {
  id: string
  roomId: string
  seatNo: number
  roleId: string | null
  controller: PlayerController
  displayName: string
  userId: string | null
  agentSessionId: string | null
  status: string
  createdAt: string
}

export interface RoundInstanceRecord {
  id: string
  roomId: string
  roundDefinitionId: string
  roundIndex: number
  type: RoundType
  status: 'active' | 'completed'
  publicVersionAtStart: number
  turnOrder: string[]
  turnIndex: number
  startedAt: string
  completedAt: string | null
}

export interface PlayerRoundStateRecord {
  roundInstanceId: string
  roomPlayerId: string
  lastSeenPublicVersion: number
  doneAtPublicVersion: number | null
  discussionFinished: boolean
  activationCount: number
  initialActionDone: boolean
  searchActionsUsed: number
  searchFinished: boolean
  updatedAt: string
}

export interface RoomEventRecord {
  id: string
  roomId: string
  roundInstanceId: string | null
  seq: number
  actorPlayerId: string | null
  type: RoomEventType
  visibility: EventVisibility
  ownerPlayerId: string | null
  targetPlayerId: string | null
  payload: Record<string, unknown>
  createdAt: string
}

export interface ClueHoldingRecord {
  id: string
  roomId: string
  roomPlayerId: string
  clueId: string
  acquiredEventId: string
  state: 'private' | 'public'
  revealedEventId: string | null
  createdAt: string
}

export interface PendingInteractionRecord {
  id: string
  roomId: string
  roundInstanceId: string
  type: 'question'
  fromPlayerId: string
  toPlayerId: string
  sourceEventId: string
  status: 'pending' | 'answered' | 'declined'
  resolvedEventId: string | null
  createdAt: string
  resolvedAt: string | null
}

export interface VoteRecord {
  roomId: string
  roundInstanceId: string
  roomPlayerId: string
  targetRoleId: string
  reasoning: string | null
  submittedAt: string
}
