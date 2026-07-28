## Review

- Correct: The scaffold matches the stated intent. `DOMAINS` remains empty, the provisional home is wired through the SDK, and no domain, HTTP client, or authentication implementation was added (`src/cli.ts:18`, `src/cli.ts:46`, `src/commands/home.ts:12`).
- Correct: Installed `axi-sdk-js@0.1.8` behavior supports the implementation: returned objects are TOON-encoded, strings pass through verbatim, home headers are merged, and command help is resolved through `getCommandHelp`. Subcommand help correctly recovers the subcommand from `argv[1]` (`src/cli.ts:37-43`).
- Correct: The owner-approved fixes remain present: `SubcommandSpec.route` is absent (`src/core/registry.ts:67-75`), `prepack` builds the package (`package.json:21`), top-level help labels domains (`src/cli.ts:62-66`), and the packaged README uses an absolute design link (`README.md:5`).
- Correct: Both observable runtime dependencies are exactly pinned in `package.json:27-28` and resolve to those versions in the lockfile.
- Blocker: None.
- Note: No concrete material bugs or regressions were found. Per instruction, this was static inspection only and tests, builds, lint, and typecheck were not run.