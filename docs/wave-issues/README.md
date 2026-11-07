# Wave issue drafts

These drafts describe the remaining indexer work in dependency order. Open them
as GitHub issues only after the repository is approved for the Stellar Wave.

| Issue | Dependency |
|---|---|
| Persist parser-backed normalization | parser alpha.2 pin |
| Reconciliation and health drift | decoded tables |
| Production deployment and soak proof | health drift |

Every issue must include tests, provenance, and an explicit limitation when a
dependency is not available. No issue should ask a contributor to add fixture
data without recording its network, ledger, RPC, transaction hash, and sha256.
