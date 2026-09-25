# Architecture

The repository is a pnpm monorepo with three runtime boundaries:

- `murder-mystery-web` is a React/Vite SPA and consumes same-origin API routes.
- `murder-mystery-api` is a Hono service bound to loopback. It owns room commands, projections, game progression, SQLite and AI player scheduling.
- `murder-mystery-shared` contains request and response types used by both applications.

The API stores game state and AI player sessions in separate SQLite files. Each AI receives public script material, the public room timeline and only its own private role and clue information. Queries enforce the same player boundary for human callers. If an active room refers to a missing or incompatible AI session, the API creates a new session and reconstructs its context from the persisted room state.
