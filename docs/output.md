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
Empty results are explicit.
See [the command reference](commands.md) for supported fields and flags on each command.

## Errors and exits

TOON data, errors and recovery suggestions go to stdout; diagnostics go to stderr.
Errors expose `error`, `code` and recovery `help` where available.
See [the README exit table](../README.md#output-and-exit-codes) for process exit meanings.
For `PROFILE_REQUIRED`, configure an origin and SecretRef or inject the complete environment profile.
For `AUTH_REQUIRED`, check the selected credential; for `FORBIDDEN`, check the account's AWX roles.
Use `awx-axi doctor` to inspect the selected identity and credential permissions.
