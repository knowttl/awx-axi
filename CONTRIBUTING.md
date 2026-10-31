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
The repository validation configuration runs build, typecheck, tests and lint; also check command-documentation drift with the command above.
Release automation remains separate and retains tags in the `awx-axi-vX.Y.Z` format.

The default test suite uses offline transports and synthetic fixtures and excludes `test/live/`.
The installed-package tests in `test/package.test.ts` install a packed tarball with `npm install --prefer-offline`, reusing cached dependencies but permitting registry access when needed.
An empty npm cache therefore requires registry access for `npm test`.
Run tests with temporary HOME, XDG_CONFIG_HOME, XDG_STATE_HOME, XDG_CACHE_HOME, APPDATA, and LOCALAPPDATA directories so existing local profiles and legacy files cannot affect fixture tests.
Do not contact real controllers, read local credentials, or exercise live mutations as part of ordinary validation.
Reuse the existing fixtures and test helpers when changing behavior.
`test/skill.test.ts`, included in `npm test`, verifies both generated skill copies against `src/skill.ts`.
After command changes, run `npm run build` and `npm run docs:commands` to regenerate the full command table and help in `docs/commands.md` from the built CLI registry.
The README carries a hand-maintained group overview; update it when command groups or their scope change.

Keep pull requests focused and describe the problem, resulting behavior, scope, and local validation.
