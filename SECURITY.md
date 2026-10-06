# Security Policy

This repository is part of the **Stellar-Governance-Guardians** suite
(`soroban-governance-parser` → `governance-event-indexer` → `delegate-portal-dashboard`).
The suite is read-only v1: it holds no keys, signs nothing, and custodies no value.
A report should still never wait when a defect could mislead a user.

## Reporting a vulnerability

Report privately. Do **not** open a public issue:

https://github.com/Stellar-Governance-Guardians/governance-event-indexer/security/advisories/new

Include:

- affected repo and commit or version,
- reproduction steps (commands, ledgers, tx hashes, SQL/API queries),
- impact assessment — especially whether wrong or incomplete data is presented
  as complete (e.g. an ingestion gap without an `ingest_gaps` row),
- any suggested fix, if you have one.

## What to expect

- Acknowledgement: within 72 hours (best effort — single maintainer, see CONTRIBUTING.md).
- Triage and severity call: within 7 days.
- Fix: severity-dependent; coordinated disclosure preferred. Reporters are
  credited unless they ask not to be.

## Scope notes

In scope, with examples:

- ingestion gaps presented as complete data,
- decode failures silently dropped instead of recorded and replayable,
- secrets committed anywhere in history (e.g. DATABASE_URL with credentials),
- GraphQL limit bypasses (depth/complexity),
- fail-open reconciliation (drift reported but /health stays healthy).

Out of scope:

- bugs in upstream governor contracts (report those upstream),
- findings that require a compromised maintainer account,
- availability of the public Soroban testnet RPC (not operated by this project).

## Secrets

No repository in this suite stores secrets. The dashboard holds no keys and has
no server-side secrets. If you find a leaked credential anywhere in this
project's history, report it privately and it will be revoked and handled.

## Supported versions

Pre-1.0: only the latest tagged release and `main` receive fixes.
