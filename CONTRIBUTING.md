# Contributing

Use Node.js 20 or newer and install the locked dependencies with `npm ci`.
Run the local checks before opening a pull request:

```sh
npm run build
npm run typecheck
npm run lint
npm test
npm run docs:commands -- --check
```

Local validation is the required gate for changes; hosted PR test CI is not used.
The repository validation configuration runs these existing package scripts.
Release automation remains separate and retains tags in the `awx-axi-vX.Y.Z` format.

The default test suite uses offline transports and synthetic fixtures and excludes `test/live/`.
Run tests with temporary HOME, XDG_CONFIG_HOME, XDG_STATE_HOME, XDG_CACHE_HOME, APPDATA, and LOCALAPPDATA directories so existing local profiles and legacy files cannot affect fixture tests.
Do not contact real controllers, read local credentials, or exercise live mutations as part of ordinary validation.
Reuse the existing fixtures and test helpers when changing behavior.
`test/skill.test.ts`, included in `npm test`, verifies both generated skill copies against `src/skill.ts`.
After command changes, run `npm run build` and `npm run docs:commands` to regenerate the README command table and `docs/commands.md` from the built CLI registry and help.

Keep pull requests focused and describe the problem, resulting behavior, scope, and local validation.
