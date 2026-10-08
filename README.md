# governance-event-indexer

Indexes Soroban governance events from the public Stellar testnet RPC into
Postgres — raw first, decoded second — and serves them through a read-only
GraphQL API that implements the pinned `governance-v1` schema. Fail-closed,
governor-agnostic, zero mock data in production paths.

Part of the Stellar-Governance-Guardians suite:
[parser](https://github.com/Stellar-Governance-Guardians/soroban-governance-parser) →
**[indexer](https://github.com/Stellar-Governance-Guardians/governance-event-indexer)** →
[dashboard](https://github.com/Stellar-Governance-Guardians/delegate-portal-dashboard).

## Status: I0 scaffold + I1 pins — not yet an indexer

This repository currently contains the **baseline milestone (I0)** and the
**pins milestone (I1)**: toolchain, database migrations, CI gate, repo hygiene,
and vendored, hash-locked artifacts from the parser repo. The ingestion,
decode, GraphQL, reconciliation and deployment milestones (I2–I7) are not built
yet. Nothing in this repository has been verified against live testnet *by this
repository's own evidence* yet; the statements below say exactly what has been
checked and how.

## What it will do (planned, I1–I7)

- **Ingest** `getEvents` from the public testnet RPC for the governor contracts
  in the pinned deployment registry, in ≤1000-ledger windows, persisting raw
  events first (idempotent, restart-safe, with explicit `ingest_gaps` rows when
  the RPC retention window has been passed — never a silent skip).
- **Decode** raw events through the pinned `soroban-governance-parser` WASM
  package (Script3 adapter) into proposals, actions, risk flags, votes, power
  checkpoints, delegations and delegates. Decode failures are stored and
  replayable, never dropped.
- **Serve** the vendored `governance-v1` GraphQL schema (Yoga) with depth and
  complexity limits, delegate metrics as raw counts plus published formulas
  (see [SPEC.md](SPEC.md) — no opaque scores), and an `indexerStatus`-style
  health surface that reports lag, open gaps and reconciliation drift.
- **Reconcile** SQL tallies against on-chain reads and fail health checks on
  nonzero drift or excess lag.
- **Deploy** via Docker image + compose for a small VPS or hosted Postgres
  (the 72h soak run must not live in a sleeping Codespace).

## What I0 + I1 provide (proven — machine-checked)

Every claim in this section is an entry in [claims.json](claims.json), checked
by `scripts/check-claims.sh` in CI (offline tier; skips print as SKIP, never
PASS):

| claim id | what is checked |
|---|---|
| `node-24-engine` | package requires Node ≥ 24 |
| `devcontainer-node-24` | devcontainer provisions Node 24 (docker-in-docker, Postgres client, gitleaks) |
| `postgres-16-compose` | `docker-compose.yml` pins `postgres:16` |
| `strict-typecheck` | `tsc --noEmit` passes under the strict flag set |
| `eslint-clean` | `eslint .` passes |
| `unit-tests` | unit tests pass offline (no database, no network) |
| `integration-migrations-from-empty` | forward-only migrations apply from an empty database, are idempotent, and round-trip through Postgres — local Postgres only, no testnet |
| `no-fixture-imports-in-src` | production code in `src/` never references fixtures (charter rule 1) |
| `license-mit` | LICENSE is the MIT license (copyright 2026 Stellar-Governance-Guardians) |
| `gitleaks-pinned` | gitleaks 8.30.1 pinned in the devcontainer and the CI gate |
| `pr-gate-offline` | the PR-gate workflow never references a testnet RPC endpoint |
| `pins-match` | every vendored artifact hash-matches its pin (`schema.lock` / `registry.lock` / `parser.lock`), offline |
| `pin-urls-reachable` *(online tier)* | the pinned upstream URLs resolve with identical bytes — nightly, never a merge gate |

The PR gate is **offline and deterministic**: no workflow in the PR-gate path
talks to the testnet. Live-testnet checks belong to a nightly/manual workflow
and never block merges.

## Pinned artifacts (interface contract)

This repo consumes the parser repo **only through pinned artifacts**. Three
locks, all verified offline in every PR by `node scripts/check-pins.mjs`, plus
a nightly reachability check (`.github/workflows/nightly-pins.yml`) that fails
on an unreachable pin or upstream drift:

| pin | pins | vendored at |
|---|---|---|
| [`schema.lock`](schema.lock) | `schemas/governance-v1.graphql` @ parser commit `ba3bf1a3ee7525215f3d3e919974f8b7fbaf0b74` (sha256 `cfbd85a8…`) | `schema/governance-v1.graphql` |
| [`registry.lock`](registry.lock) | `deployments.json` @ the same parser commit (sha256 `b8c71c34…`) | `deployments.json` |
| [`parser.lock`](parser.lock) | WASM release asset `sgg-parser-wasm-0.1.0-alpha.1.tgz` (sha256 `7b2eb942…`, matching the parser's release notes) | `vendor/sgg-parser-wasm-0.1.0-alpha.1.tgz` |

Locks are bumped only by a PR that shows the diff and re-runs the checks. The
vendored WASM is the parser's published **v0.1.0-alpha.1** pre-release; it has
not yet been exercised by this repo's decode milestone (I3) — see limitations.

## Not proven / Honest limitations

- **No ingestion yet.** `raw_events`, cursors, gap detection and fixture replay
  land in I2. This repo has not yet indexed a single ledger.
- **No GraphQL endpoint yet** (I4), **no reconciliation** (I5), **no deployed
  instance or soak run** (I6), **no clean-clone prove script** (I7).
- **The parser WASM asset is pinned and hash-verified but unused.** Decode
  (I3) has not run against it from this repo; nothing here decodes anything yet.
- **No live evidence from this repo.** Fixture provenance from the parser repo
  will be pinned and cited, but this repo's own live-verification claims start
  at I7 (`scripts/prove-indexer`). Pin reachability is checked nightly (online
  claims tier), not per-PR, because the PR gate must stay offline.
- **Integration tests need Postgres** (docker compose or the CI service
  container); `npm test` fails loud without `DATABASE_URL` instead of skipping.
- The testnet is periodically reset; pinned artifacts can become unreachable —
  the nightly pin-reachability check (I1) is designed to catch that, and any
  unverified item will be listed here rather than claimed as working.

## Quick start

```bash
git clone https://github.com/Stellar-Governance-Guardians/governance-event-indexer
cd governance-event-indexer
npm ci

docker compose up -d postgres            # local Postgres 16
export DATABASE_URL='postgres://indexer:indexer-local-only@localhost:5432/indexer'

npm run typecheck && npm run lint        # static gates
npm test                                 # unit + integration
npm run build && node dist/cli.js migrate  # forward-only migrations
```

## Codespaces / dev container

Open in Codespaces:
<https://codespaces.new/Stellar-Governance-Guardians/governance-event-indexer>

The devcontainer (`.devcontainer/devcontainer.json`) provides Node 24,
docker-in-docker, the Postgres client and a pinned gitleaks. Rules that apply
there:

- **Secrets come only from Codespaces secrets / env vars** — `DATABASE_URL`,
  keys, tokens. Never commit them; `.seed/` and `.env*` are gitignored.
- **Run `gitleaks detect --redact` before every push.**
- Codespaces **sleep when idle**: nothing that must stay up (the 72h soak run)
  runs inside one — see the deploy recipe milestone (I6).

## Development commands

| command | what it does |
|---|---|
| `npm run typecheck` | strict TypeScript, no emit |
| `npm run lint` | ESLint (incl. the fixture-import ban on `src/`) |
| `npm run test:unit` | offline unit tests |
| `npm run test:integration` | migrations/schema tests against Postgres |
| `npm test` | both test tiers (fails loud if Postgres is down) |
| `npm run build` | compile `src/` → `dist/` |
| `npm run migrate` | build + apply pending migrations to `$DATABASE_URL` |
| `bash scripts/check-claims.sh` | run the claims ledger (offline tier: `OFFLINE=1`) |

## Claims ledger

README/SPEC claims are machine-checked (charter rule 7): each one is an entry in
[claims.json](claims.json) with the exact command that verifies it, executed by
[scripts/check-claims.sh](scripts/check-claims.sh) in CI. Two tiers: the PR gate
runs `OFFLINE=1` (deterministic, network-free); live-testnet claims run in the
nightly/manual workflow only. Skips are reported as SKIP, never as PASS.

## Security

See [SECURITY.md](SECURITY.md) — report vulnerabilities privately, never in a
public issue. The indexer is read-only v1: it holds no keys, signs nothing, and
writes only to its own database.

## License

[MIT](LICENSE) — same as the parser repo.
