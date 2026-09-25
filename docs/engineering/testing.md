# Testing

Run the repository checks before merging:

```bash
pnpm typecheck
pnpm test
pnpm build
```

The API E2E test uses mock AI. Changes to room commands, projections, scheduling or player privacy must retain coverage for room isolation, private clue visibility and sealed voting.
