#!/usr/bin/env bash
# Idempotent tool bootstrap for the indexer devcontainer.
#
# Installs what the repo's scripts expect that is not a devcontainer feature:
# gitleaks (pre-push secret scan, charter rule 6). Node 24, docker-in-docker,
# the Postgres client (psql/pg_isready) and gh come from devcontainer features.
#
# Nothing secret is written here. `DATABASE_URL`, funded testnet keys and any
# other credentials come only from Codespaces secrets / env vars (see README);
# `.seed/` and `.env*` stay gitignored.
set -euo pipefail

say() { printf '\n==> %s\n' "$1"; }

say "node"
node --version
npm --version

# --- gitleaks -----------------------------------------------------------------
# Pinned release; bump deliberately. Must be >= 8.21 (the release that added
# multiple `[[allowlists]]`, which .gitleaks.toml uses): older builds silently
# ignore the allowlist.
say "gitleaks"
GITLEAKS_VERSION="8.30.1"
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks version
else
  arch="$(uname -m)"
  case "$arch" in
    x86_64) gl_arch="x64" ;;
    aarch64) gl_arch="arm64" ;;
    *) echo "unsupported arch for gitleaks: $arch" >&2; exit 1 ;;
  esac
  tmp="$(mktemp -d)"
  curl -sSfL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${gl_arch}.tar.gz" \
    | tar -xz -C "$tmp" gitleaks
  sudo install -m 0755 "$tmp/gitleaks" /usr/local/bin/gitleaks
  rm -rf "$tmp"
  gitleaks version
fi

# --- project dependencies ------------------------------------------------------
say "npm ci"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

cat <<'EOF'

Done. Common commands:
  npm run typecheck        # strict TypeScript, no emit
  npm run lint             # ESLint
  npm test                 # unit + integration (integration needs docker compose up -d postgres)
  npm run migrate          # apply forward-only migrations to $DATABASE_URL
  gitleaks detect --redact # secret scan (run before every push)

Codespaces: DATABASE_URL comes from Codespaces secrets, never from a file.
EOF
