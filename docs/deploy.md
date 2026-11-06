# Production deployment

The production compose file runs Postgres on an internal Docker network. It
does not publish a database port. Caddy is the only public service and obtains
HTTPS certificates for `INDEXER_DOMAIN`.

Before deployment, configure the host firewall for TCP 22, 80, and 443 only.
Set `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, and
`INDEXER_DOMAIN` in the host environment. Never commit these values.

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec indexer node dist/cli.js migrate
```

Back up the database nightly with `pg_dump` from inside the internal network,
then restore into a disposable Postgres container and run the migration and
health checks. The deployment workflow consumes `DEPLOY_HOST`, `DEPLOY_USER`,
and `DEPLOY_SSH_KEY` from Actions secrets; it does not contain credentials.
