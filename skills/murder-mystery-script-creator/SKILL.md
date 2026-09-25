---
name: murder-mystery-script-creator
description: Create, revise, and validate ZIP script packages for AI Murder Mystery. Use when turning a story idea into an importable game script, or checking an existing script package before import.
---

# Murder Mystery Script Creator

Create a playable, importable `schemaVersion: "1.0"` murder-mystery package without modifying game-engine code. The platform owns rules and phase behavior; the package supplies only narrative data in the supported format.

## Work in two modes

### Explore or revise a story

Treat creative discussion as an iterative design conversation, not a form to be completed in one turn. Start from the material the user has given. Keep a compact, visible working brief and update it after each decision. Offer alternatives when they unblock a creative choice, but do not force a house style or invent a premise the user has not approved.

Before generating package files, obtain or explicitly mark as author-approved assumptions for these release-gate facts:

- player/role count and intended tone;
- victim, killer, motive, method, opportunity, and a chronological crime timeline;
- each role's public identity, private knowledge, goal, and relationships;
- locations and a clue plan that lets players independently infer the solution;
- the killer role ID and the final explanation.

Ask only for the missing facts that prevent a coherent package. If the user wants help inventing them, propose them as editable options. Never expose a role's private story, facts, secrets, goals, relationships, or the outcome as public context or another role's private information. Do not claim that a mystery is fair until its clue plan has been reviewed.

Read [authoring review](references/authoring-review.md) when assessing story completeness, information isolation, or clue fairness.

### Produce an importable package

Read [package format](references/package-format-v1.md) before creating or changing package files. Create exactly the fields that the current importer recognizes; do not add custom phase types, actions, executable logic, prompt templates, or unsupported content files.

Use stable kebab-case IDs and JSON data, then serialize valid UTF-8 JSON. Create a ZIP whose single root directory is exactly the script ID. Put only allowed package files inside it. A compact `README.md` for authors is optional and never contains a substitute for required game data.

Use the platform validator, from the repository root, before presenting an artifact as ready:

```bash
pnpm --filter @ai-murder-mystery/api exec tsx ../../skills/murder-mystery-script-creator/scripts/validate-package.ts <absolute-path-to-package.zip>
```

This command runs the API's actual `ScriptPackageImporter` in an in-memory database. It is the compatibility gate. Fix its reported error rather than weakening or bypassing validation. Run it again after every change to `manifest.json`, `game.json`, archive structure, or version. On success, report the package path and the normalized identity/title/player count it prints; on failure, report the exact error code plus the smallest author-facing explanation and the proposed correction.

The validator checks import compatibility, not narrative quality. Before delivery, perform the authoring review for a newly created or substantially revised mystery, and plainly call out remaining creative risks rather than silently filling them with canon.

## Boundaries

- The first phase, game flow, supported actions, and ZIP whitelist are platform contracts, not creative preferences. Keep them exact.
- Preserve creative freedom in setting, era, cast, motives, clue wording, phase titles, locations, and supported phase sequencing.
- Never upload a draft to a production import endpoint as a validation shortcut. Generate locally and validate locally.
- A published `id + version` is immutable. Content changes require a new SemVer version; do not overwrite an already-released package.
- Do not add source-code changes to make a story fit. If the desired mechanic is unsupported, explain the constraint and offer the closest supported design or a separately scoped platform feature request.
