# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- `docs/design.md` is the accepted v1 design and is authoritative. Do not edit it to fit an implementation; escalate instead.
- Every CLI surface and every review follows the AXI skill at `/home/btsai/.pi/agent/skills/axi/SKILL.md` (10 principles: command shape, output shape, help text, error style).
- Commands: `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`. Scripts are in `package.json`.
- There is deliberately no CI workflow: GitHub Actions is disabled on this account, so the local commands above are the only gate. Do not add a workflow file without the captain's word.
- `axi-sdk-js` and `@toon-format/toon` are pinned to exact versions on purpose (design §12): the encoder's emitted syntax is observable output, so an upgrade must be a reviewed change with a snapshot diff.
- `axi-sdk-js@0.1.8` root-exports only `runAxiCli`, `AxiError`, `exitCodeForError`, `installSessionStartHooks`, `RESERVED_COMMANDS`, and the `update` helpers. The rendering helpers (`renderOutput`, `errorOutput`, `renderError`, `homeHeaderOutput`) and the `AxiRenderable` type are **not** importable: render by returning a value to the loop, report errors by throwing an `AxiError` at it.
- The captain's AWX controller is read-only by standing order: read-only GETs only, and minting a token is a POST and therefore also forbidden. Never read, print, or commit any value from `~/.config/awx-axi/live-smoke.env`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
