# Production deployment

The production compose file runs Postgres on an internal Docker network. It does
not publish a database port. Caddy is the only public service and obtains HTTPS
certificates for `INDEXER_DOMAIN`.

Before deployment, configure the host firewall for TCP 22, 80, and 443 only.
Set `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `INDEXER_DOMAIN`, and
optionally `RPC_URL` and `HEALTH_CACHE_MS` in the host environment. Never commit
these values.

## Order of operations

`indexer` waits for Postgres to report healthy (`depends_on` +
`condition: service_healthy`, and a `pg_isready` healthcheck on the database).
Postgres does **not** run migrations; that is an explicit, idempotent step:

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec indexer node dist/cli.js migrate
```

Running `migrate` twice is safe: applied migrations are recorded and skipped, so
the command is the routine post-deploy step.

The image itself is health-checked with the same `/health` endpoint Caddy and
the deploy workflow use:

```bash
docker inspect --format '{{.State.Health.Status}}' "$(docker compose -f docker-compose.prod.yml ps -q indexer)"
```

## The image contains verified parser artifacts

The runtime stage copies `generated/parser/` out of the build stage. That
directory is produced by unpacking the vendored, sha256-checked parser tarball,
so the running image decodes with the pinned parser. Without it every event
would fall back to `UNVERIFIED` with a missing-module reason. CI builds the
image, replays the committed fixtures inside it, and runs
`scripts/check-container-decode.mjs`, which fails unless the decoded rows exist
at the pinned parser version and carry the governor-shape reason.

## Error responses

`maskedErrors` is enabled. Unexpected failures (a bug, a driver error) return
`INTERNAL_SERVER_ERROR` with `extensions.unexpected: true` and no stack. Every
intentional failure — `proposal`, `delegateMetrics` and `executionImpact` while
their tables are unpopulated, an invalid page size, an invalid cursor — is
raised as a `GraphQLError`, which GraphQL Yoga passes through unmasked, so the
exact reason stays readable to the client. Do not replace this with a blanket
`false`: that leaks internals whenever something unexpected fails.

## The workflow

`.github/workflows/deploy.yml` is manual-dispatch or tag-triggered, runs in the
`production` environment, and reads `DEPLOY_HOST`, `DEPLOY_USER` and
`DEPLOY_SSH_KEY` from that environment's Actions secrets. It fails with an
explicit message naming the missing secret; it does not contain credentials and
does not deploy on a push to `main`.

## Backups

Back up the database nightly with `pg_dump` from inside the internal network,
then restore into a disposable Postgres container and run the migration and
health checks against it.
