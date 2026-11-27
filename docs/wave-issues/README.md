# Wave issue preparation — indexer

These drafts describe the remaining indexer work in dependency order. They are
for a later application or a follow-up Wave, not the initial parser-focused
submission. Open them as GitHub issues only after the repository is approved for
the Stellar Wave.

| Issue | Dependency |
|---|---|
| Persist parser-backed normalization | parser alpha.2 pin |
| Reconciliation and health drift | decoded tables |
| Production deployment and soak proof | health drift |

## Readiness classification

- **01 Persist parser-backed normalization:** delivered. Event-level
  normalization (I3) and the verified `proposal_created` → `proposals`
  projection (I5) are on `main` and served by the `proposal` query. Do not offer
  this draft as new work; the remaining scope is vote/tally and delegate
  projection, which needs its own issue and capture requirements.
- **02 Reconciliation and health drift:** not ready until verified decoded
  proposal rows exist. It should remain a follow-up issue with fixture and
  provenance requirements.
- **03 Deployment and soak proof:** not ready until health drift is resolved
  and an actual deployment target is available.

The indexer README truthfully states that no live deployment has indexed a
ledger. The repository should therefore not be the anchor application until a
contributor can work against a stable parser-backed data set.

Every issue must include tests, provenance, and an explicit limitation when a
dependency is not available. No issue should ask a contributor to add fixture
data without recording its network, ledger, RPC, transaction hash, and sha256.
