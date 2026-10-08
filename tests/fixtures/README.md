# tests/fixtures — provenance ledger

Charter rule: every fixture here is a **committed raw response with
provenance**, or a byte-identical copy of one from a sibling repo at a pinned
commit. No hand-written mock data. CI fails if anything in `src/` references
this directory (charter rule 1); fixtures are consumed only by tests and by
the `replay` command, which takes the directory as an explicit argument.

Test doubles built inline in `tests/**/*.test.ts` (synthetic events, stub RPC
clients) are test code, not fixtures — they live in test files, never here.

## replay/

| file | what | provenance |
|---|---|---|
| `phase1-fixture-events.json` | raw `getEvents` response: the two governance events (`proposal_created`, `vote_cast`) of our deployed fixture governor | byte-identical copy (sha256 `f6da47ea6873e362bb6ce88c1ca25bfe6ed4b198c03a22854597609a0b4d2b25`) of `tests/fixtures/phase1-fixture-events.json` in the parser repo at pinned commit `ba3bf1a3ee7525215f3d3e919974f8b7fbaf0b74` (verified identical to parser HEAD `f4a76c968906a60e7c6ccd610b509279cbb5b5cb` on 2026-10-08) |

Original provenance (from the parser repo's fixtures README, preserved here):
captured from live Stellar testnet — SDF public RPC
`https://soroban-testnet.stellar.org` — on 2026-10-05; contract
`CDJWPKSQ4NA67PKTNJEPI6R2Q3JEDXPX5EDPM3YOSEHBDGBZ5THBTOKE`;
`proposal_created` at ledger 5035906, tx
`34dd7cef8df6234f381563fff88b27a1163557f344f39832ff0e9901711215e3`;
`vote_cast` at ledger 5035908, tx
`ddef35404ed2fbef74c1e2324af631398aed9949ff2c7586d56d7cb17bfbea38`.

## Replaying

```bash
node dist/cli.js replay tests/fixtures/replay
```

The replay command normalizes these raw responses through **the same code
path as live ingestion** and tags rows `source='fixture-replay'`. Live rows
are `source='live'`; the two are never mixed silently (charter: sources are
always distinguishable). Replay never reads or advances `ingest_cursors`.

## Re-vendoring

Fixtures move only through a pin-bump PR that shows the diff and re-runs the
checks (interface contract). Verify the copy against `registry.lock`'s pinned
commit with `git show <sha>:tests/fixtures/<path> | sha256sum`.
