# awx-axi

AXI-standard agent-native CLI for AWX (Ansible automation platform).

The current build is the shared core plus `awx-axi auth`. No AWX domain
(`job`, `template`, `workflow`, `project`, `approval`) is registered yet.

## Configuration

awx-axi reads the same environment variables the official CLI uses, so a
configured controller needs no new setup:

| Variable | Meaning |
| --- | --- |
| `CONTROLLER_HOST` | Controller base URL, e.g. `https://awx.example.com` |
| `CONTROLLER_OAUTH_TOKEN` | Bearer token, the preferred credential |
| `CONTROLLER_USERNAME` / `CONTROLLER_PASSWORD` | Used by `auth login` alone, to mint a token |
| `CONTROLLER_VERIFY_SSL` | `false` disables TLS verification |
| `AWX_AXI_HOME` | Token file location, default `~/.awx-axi` |
| `AWX_AXI_READ_ONLY` | `1` makes every mutating request refuse before it is issued |

No secret is ever a command-line argument: credentials arrive through the
environment or through the `0600` token file.

## Testing

Every test that gates the build runs **offline**, against fixtures derived from
the AWX 24.6.1 source rather than recorded from a live controller. Each fixture
in `test/fixtures/` records the source file and line it came from, so it can be
re-verified against the tag rather than trusted.

That is a real limitation and worth stating plainly: nothing in this build has
executed a launch, cancel, sync, or approval against a real controller. Those
paths are exercised against fixtures and reasoned from the 24.6.1 source.

```
npm ci && npm run typecheck && npm run build && npm run lint && npm test
```

See [docs/design.md](https://github.com/knowttl/awx-axi/blob/main/docs/design.md) for the v1 design.
