# Persist parser-backed event normalization

## Summary

Move parser-backed normalization from GraphQL read time into an explicit,
replayable decode stage. Raw events remain immutable; decoded output and decode
errors are stored separately so a parser pin can be upgraded and replayed
without re-fetching the public RPC.

## Acceptance criteria

- [x] Add a forward-only migration for normalized events and explicit statuses.
- [x] Decode through the pinned parser WASM; no governor-specific branch in the
      ingestion layer.
- [x] Preserve the raw event key, parser version, decoding status, and exact
      failure reason for every row.
- [x] Replaying the same raw capture is idempotent and byte-stable.
- [x] GraphQL exposes verified fields only when normalization succeeded; raw
      payload and `UNVERIFIED` status remain available otherwise.
- [x] Add integration coverage using committed captures and the existing parser
      pin check.

Remaining scope is proposal/action projections and broader decode-failure
analytics; those belong in follow-up issues rather than being implied by this
event-level milestone.

## Tech stack

TypeScript, Kysely, PostgreSQL 16, vendored parser WASM, Vitest, GraphQL Yoga.
