# Task for reviewer

Perform an independent read-only code review of HEAD f207bf3 relative to base 8dfb7fb. Do not edit files and do not run tests, builds, lint, or typecheck. Inspect the complete changed source, relevant surrounding docs/design.md and installed axi-sdk-js 0.1.8 behavior. Respect the authoritative user intent: this is intentionally only an empty scaffold, DOMAINS must remain empty, no domains/HTTP/auth/etc., provisional home is required, exact dependency pins are deliberate, and prior owner-approved fixes removed SubcommandSpec.route, added prepack, made subcommand help recover argv[1], labeled top-level help domains, and changed README design link absolute. Identify only concrete material bugs/risks introduced by the changed code, with file and changed line. Do not repeat resolved prior findings unless the current code remains materially defective. Return concise findings or clean assessment.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```