# Publish deployment recipe and a 72-hour soak proof

## Summary

Make the indexer reproducible on a small hosted service with private Postgres,
public HTTPS, backups, and an observable health endpoint. Run a 72-hour soak
without allowing a sleeping development environment to become production.

## Acceptance criteria

- [ ] Pin image/runtime versions and document build/start/migrate commands.
- [ ] Keep Postgres on a private network and document secret injection without
      committing credentials.
- [ ] Add backup and restore instructions tested against a disposable database.
- [ ] Record a soak report with lag, open gaps, restart, and recovery evidence.
- [ ] Add a clean-clone prove script that runs without local-only files.

## Tech stack

Docker Compose, Node 24, PostgreSQL 16/17, Caddy, GitHub Actions, gitleaks.
