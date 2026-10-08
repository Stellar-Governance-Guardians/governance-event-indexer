#!/usr/bin/env bash
# Claims ledger checker (charter rule 7). Runs every claim in claims.json and
# reports PASS/FAIL. Exit non-zero on any FAIL.
#
# Two-tier modes (process rule: PR gate is offline + deterministic):
#   OFFLINE=1     -> PR gate: run only deterministic, network-free claims
#   ONLINE_ONLY=1 -> live tier (nightly/manual dispatch): run only testnet claims
#   (default)     -> run everything
# Skipped claims are reported as SKIP, never as PASS.
set -u
cd "$(dirname "$0")/.."

OFFLINE="${OFFLINE:-0}"
ONLINE_ONLY="${ONLINE_ONLY:-0}"
python3 - "$OFFLINE" "$ONLINE_ONLY" <<'PYEOF' > /tmp/indexer-claims-generated.sh
import json, sys
offline = sys.argv[1] == "1"
online_only = sys.argv[2] == "1"
claims = json.load(open("claims.json"))["claims"]
print("set -u")
print("FAILED=0; PASSED=0; SKIPPED=0")
for c in claims:
    # Escape for embedding in the generated double-quoted `bash -c "..."`:
    # `"` must not close the string, `$` must expand in the inner shell only.
    cmd = c["check"]["cmd"].replace('"', '\\"').replace("$", "\\$")
    online = bool(c.get("online"))
    skip = (online_only and not online) or (offline and online)
    if skip:
        why = "live tier only" if online_only else "OFFLINE=1"
        print(f'echo "SKIP  {c["id"]} ({why})"; SKIPPED=$((SKIPPED+1))')
    else:
        print(f'if bash -c "{cmd}" >/dev/null 2>&1; then echo "PASS  {c["id"]}"; PASSED=$((PASSED+1)); else echo "FAIL  {c["id"]}: {c["claim"]}"; FAILED=$((FAILED+1)); fi')
print('echo "claims: $PASSED passed, $FAILED failed, $SKIPPED skipped"')
print('test "$FAILED" -eq 0')
PYEOF

bash /tmp/indexer-claims-generated.sh
status=$?
rm -f /tmp/indexer-claims-generated.sh
exit $status
