# Add reconciliation and fail-loud health drift

## Summary

Compare indexed proposal state and tallies with the on-chain reads captured by
the parser suite. Expose drift as data and make `/health` and `indexerHealth`
unhealthy when the configured tolerance is exceeded.

## Acceptance criteria

- [ ] Store a reconciliation run with start ledger, end ledger, counts, and
      every mismatch reason.
- [ ] Do not convert missing history or retention gaps into a clean result.
- [ ] Expose raw mismatch counts and the formula used for each health field.
- [ ] Add deterministic fixture tests for clean, stale, and divergent runs.
- [ ] Document the operational response to an unhealthy indexer.

## Tech stack

TypeScript, Kysely, PostgreSQL, Soroban JSON-RPC, GraphQL Yoga, Vitest.
