# Script package format v1

The current source of truth is `apps/murder-mystery-api/src/domain/script/importer.ts`. This reference is a concise authoring aid; run the skill validator before delivery.

## Archive contract

The ZIP must be at most 10 MiB and contain 3–64 entries. It has exactly one root directory, whose name equals `manifest.id`.

```text
<script-id>/
  manifest.json                 required
  game.json                     required
  README.md                     optional
  assets/…                      optional
```

No other files are accepted. Entry paths must not be absolute, contain `..`, or use backslashes. Asset files are accepted structurally but v1 game data does not reference them, so include them only when a future packaging workflow explicitly needs them.

`manifest.json` is UTF-8 JSON and contains these required importer fields:

```json
{
  "schemaVersion": "1.0",
  "id": "midnight-harbor",
  "version": "1.0.0",
  "title": "午夜港湾",
  "description": "一场暴雨中的六人推理。",
  "minPlayers": 6,
  "maxPlayers": 6
}
```

`id` is lowercase kebab-case. `version` is SemVer, including an optional prerelease suffix. Both player counts must be integers and exactly equal the number of roles. `entry` and `defaultLocale` may be included for author metadata but are not currently read by the importer.

## game.json

Required top-level keys are `publicContext`, `roles`, `locations`, `phases`, `clues`, and `outcome`.

### Roles

Every role must have non-empty `id`, `name`, `gender`, `occupation`, `publicProfile`, integer `age` (1–150), and:

```json
{
  "private": {
    "story": "This role's private narrative.",
    "facts": ["Facts this role knows."],
    "secrets": ["Information this role may hide."],
    "goals": ["Role objectives."],
    "relationships": ["Relationship notes."]
  },
  "deceptionPolicy": {
    "mayHideOwnFacts": true,
    "mayLieAboutOwnActions": true,
    "forbiddenWorldFabrication": true
  }
}
```

All role IDs must be unique. Arrays may be empty when that is an intentional design choice, but every item in an array must be a non-empty string.

### Locations and clues

Each location has unique non-empty `id`, `name`, and `description`.

Each clue has unique non-empty `id`, `title`, `phaseId`, `content`, and this v1 shape:

```json
{
  "source": { "kind": "location", "id": "location-id" },
  "distribution": {
    "kind": "per_player_random",
    "revealPolicy": "owner_decides"
  }
}
```

`revealPolicy` is one of `forced_public`, `owner_decides`, or `private`. A clue's `phaseId` must identify an investigation phase and `source.id` must identify a location. The importer only validates references, so separately review whether enough clues are reachable for the intended deductions.

### Phases: required flow

There must be 5–10 phases. Their IDs are unique and titles non-empty. Use author-selected IDs; the rules depend on field values, not a special phase name.

1. The first phase is a discussion with `mode: "ordered"`, `requiredAction: "introduce"`, and `turnOrder: "random"`.
2. Before the ending there is at least one investigation and at least one additional discussion.
3. The penultimate phase is a vote; the last is a reveal.

A discussion phase:

```json
{
  "id": "discussion-one",
  "kind": "discussion",
  "title": "第一轮讨论",
  "discussion": { "mode": "free" },
  "allowedActions": ["send_message", "ask_player", "reply_question", "decline_question", "yield_turn", "finish_round", "pass"]
}
```

Supported modes are `ordered`, `free`, and `ordered_opportunity_then_free`. If `requiredAction` is present, it must be `introduce`; if `turnOrder` is present, it must be `random` or `seat`. For an introduction phase, the importer always applies `allowedTools: ["send_message"]`, but still provide the conventional `allowedActions` shown in the example package.

An investigation phase:

```json
{
  "id": "search-one",
  "kind": "investigation",
  "title": "第一轮搜证",
  "investigation": { "actionsPerPlayer": 1, "searchTargets": "locations" },
  "allowedActions": ["search_clue", "reveal_clue", "keep_clue_private", "finish_search"]
}
```

`actionsPerPlayer` is an integer from 1 through 3 and `searchTargets` must be `locations`.

Vote and reveal use these exact kinds. The importer sets their legal tools itself:

```json
{ "id": "vote", "kind": "vote", "title": "指认真凶", "allowedActions": ["submit_vote"] }
{ "id": "reveal", "kind": "reveal", "title": "真相揭晓", "allowedActions": [] }
```

Permitted values in a discussion/investigation `allowedActions` list are: `send_message`, `ask_player`, `reply_question`, `decline_question`, `yield_turn`, `finish_round`, `pass`, `search_clue`, `reveal_clue`, `keep_clue_private`, `finish_search`, and `submit_vote`. The importer verifies membership in this list, not phase/action compatibility beyond the special cases above. Use only actions meaningful for that phase.

### Outcome

```json
{
  "outcome": {
    "murdererRoleId": "killer-role-id",
    "truth": "The complete post-game explanation."
  }
}
```

`murdererRoleId` must refer to a role. `truth` is non-empty and must not be put in public context or role cards.
