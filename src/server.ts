import { createGraphqlHttpServer, loadSchema } from './graphql/server.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/index.js';
import { createRpcClient } from './rpc/client.js';
import { createHealthCache } from './rpc/health-cache.js';

const config = loadConfig();
const rpc = createRpcClient(config.rpcUrl);
const server = createGraphqlHttpServer(
  {
    db: createDatabase(config.databaseUrl),
    rpc,
    health: createHealthCache(rpc, config.healthCacheMs),
  },
  loadSchema(),
);
server.listen(config.port, () => {
  process.stdout.write(`indexer: GraphQL listening on ${config.port}\n`);
});

const shutdown = async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
