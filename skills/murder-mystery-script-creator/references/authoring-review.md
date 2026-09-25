# Authoring review

Run this review after the package passes the import validator. It evaluates playability, not JSON conformance.

## Release-gate questions

Resolve these with the author before calling a package ready:

1. Is there one unambiguous answer to who killed whom, how, when, why, and how the culprit obtained the opportunity?
2. Does the exact timeline agree with every role card, public fact, location, and clue?
3. Does every non-killer role have a reason to be suspicious but no secret that makes the stated solution impossible?
4. Are there at least two independent, discoverable evidentiary paths to the killer that do not rely on the killer confessing?
5. Can a player distinguish core evidence from red herrings with the information eventually available?
6. Does each clue make sense at both its location and its investigation phase, with enough clues for the player/search-action budget?
7. Are public context and public profiles safe to reveal at game start? Are private cards mutually isolated? Is the full solution only in `outcome.truth`?
8. Does the content avoid unreviewed real-person allegations, copyrighted text, sensitive themes, or material that needs an audience warning?

## Useful design techniques

- Write the full chronology before role cards. Derive each alibi, contradiction, and clue from it.
- Give every major conclusion corroboration: for example, opportunity plus a physical trace, or motive plus a false alibi. A single lucky clue should not be the only route to victory.
- Give each role at least one productive action: a fact to disclose, a contradiction to investigate, or a motive to defend. Avoid filler roles that only repeat public background.
- Red herrings should be explainable by the final truth. They should create questions, not require arbitrary guessing.
- Prefer specific, falsifiable clue wording (times, mechanisms, observations) over conclusions such as “X is suspicious.”

## Reporting unresolved risks

Separate validation from editorial feedback. A clear delivery report says which importer checks passed, then lists any unresolved items as `Creative review: needs author decision` with the precise decision needed. Do not manufacture an answer to avoid a warning.
