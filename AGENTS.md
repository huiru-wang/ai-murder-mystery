# AI Murder Mystery Agent Guide

## Scope and boundaries

This repository is an independent online murder-mystery game. `apps/murder-mystery-api` owns game state, SQLite persistence, player-agent sessions and game rules. `apps/murder-mystery-web` only renders API `RoomView` data. `packages/murder-mystery-shared` owns shared API contracts.

Do not add Fanto imports, Fanto deployment paths, Fanto routes or Fanto configuration. Room queries must preserve player isolation: private scripts, private clues and sealed votes are visible only to the entitled player.

## Before changing code

- Read the relevant current documentation in `docs/` and the target module before editing.
- Make the smallest change that satisfies the request; do not introduce a new abstraction without a concrete caller.
- Treat source code, tests, configuration and schema as the executable source of truth. Current docs describe the final state, not implementation plans.
- Do not place API keys, production environment files or user SQLite data in Git.

## Commands

```bash
pnpm start:local
pnpm typecheck
pnpm test
pnpm build
```

## Documentation

Update `docs/` when an API contract, game rule, data boundary, configuration or deployment behavior changes. `docs/product/current-scope.md` changes only when a user-visible capability changes. Keep `README.md` aligned with the current local-development entry points.
