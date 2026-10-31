# Output and collection completeness

## Collections

Native collection commands support `--limit` (1-1,000 rows) or `--all` with optional `--max-rows` (1-10,000; default 10,000), with at most 100 pages.
`--all` conflicts with `--limit`; `--max-rows` requires `--all`.
`--fields`, where advertised by command help, selects additional fields.
Launch commands use `--limit` as an Ansible host pattern instead.

Pagination reports budgets, pages read, stop reason, truncation and server continuation.
When `partial_page: true`, following `next` skips undisplayed rows from that page; rerun the filtered command with a larger budget instead.
Detail aggregates read complete collections independently and fail with `INCOMPLETE_COLLECTION` if continuation stalls.
`inventory updates` reports source pagination and per-source truncation without inventing a combined server total.
`workflow template-node` reads complete credentials and edge collections and accepts no row limit.

## Logs

Job and ad-hoc stdout support `--tail` and `--lines`; job stdout also supports `--download`.
`job stdout` accepts `--full`, but it does not change the request or bypass truncation.
Empty results are explicit.
See [the command reference](commands.md) for supported fields and flags on each command.

## Errors and exits

TOON data, errors and recovery suggestions go to stdout; progress and other runtime diagnostics go to stderr.
Errors expose `error`, `code` and recovery `help` where available.
For explicit commands reporting `INVALID_RESPONSE` after a successful HTTP response, the structured error also includes `status`, `contentType`, `shape` and `shapeTruncated` on stdout.
These describe the most recent successful response; failures reading cached controller metadata have no HTTP response diagnostics.
The content type omits parameters and is `null` when absent or invalid.
The bounded shape reports paths and types, plus array counts, sampling only the first array element.
It never prints response values or validator messages.
Paths retain only short identifier-like keys after secret redaction; other keys become `<key>`.
`shapeTruncated` indicates when traversal limits omit structure.
The canonical bounds and key rules live in `src/response-diagnostics.ts`; `test/response-diagnostics-contract.test.ts` checks its byte-for-byte copy and shared vectors from beyondtrust-axi.
Unexpected successful responses, such as proxy login pages or malformed collection envelopes, require checking controller compatibility and proxy configuration.
See [the README exit table](../README.md#output-and-exit-codes) for process exit meanings.
For `PROFILE_REQUIRED`, configure an origin and SecretRef or inject the complete environment profile.
For `AUTH_REQUIRED`, check the selected credential; for `FORBIDDEN`, check the account's AWX roles.
Use `awx-axi doctor` to inspect the selected identity and credential permissions.
