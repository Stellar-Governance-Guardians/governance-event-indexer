import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_PORT,
  DEFAULT_RPC_URL,
  loadConfig,
  parsePort,
  parseRpcUrl,
  requireDatabaseUrl,
} from '../../src/config.js';

describe('requireDatabaseUrl', () => {
  it('fails loud when DATABASE_URL is missing', () => {
    expect(() => requireDatabaseUrl({})).toThrow(ConfigError);
    expect(() => requireDatabaseUrl({ DATABASE_URL: undefined })).toThrow(/DATABASE_URL is not set/);
    expect(() => requireDatabaseUrl({ DATABASE_URL: '' })).toThrow(/DATABASE_URL is not set/);
  });

  it('rejects non-postgres schemes instead of failing deep in the driver', () => {
    expect(() => requireDatabaseUrl({ DATABASE_URL: 'http://localhost/db' })).toThrow(
      /postgres:\/\//,
    );
    expect(() => requireDatabaseUrl({ DATABASE_URL: 'localhost:5432/db' })).toThrow(
      /postgres:\/\//,
    );
  });

  it('accepts postgres and postgresql URLs', () => {
    expect(requireDatabaseUrl({ DATABASE_URL: 'postgres://u:p@host:5432/db' })).toBe(
      'postgres://u:p@host:5432/db',
    );
    expect(requireDatabaseUrl({ DATABASE_URL: 'postgresql://host/db' })).toBe(
      'postgresql://host/db',
    );
  });
});

describe('parsePort', () => {
  it('defaults to 4000 and validates explicit values', () => {
    expect(parsePort({})).toBe(DEFAULT_PORT);
    expect(parsePort({ PORT: '8080' })).toBe(8080);
    expect(() => parsePort({ PORT: '0' })).toThrow(ConfigError);
    expect(() => parsePort({ PORT: '70000' })).toThrow(/between 1 and 65535/);
    expect(() => parsePort({ PORT: 'eight' })).toThrow(/integer/);
  });
});

describe('parseRpcUrl', () => {
  it('defaults to the public testnet RPC and validates overrides', () => {
    expect(parseRpcUrl({})).toBe(DEFAULT_RPC_URL);
    expect(parseRpcUrl({ RPC_URL: 'https://rpc.example.org' })).toBe('https://rpc.example.org');
    expect(() => parseRpcUrl({ RPC_URL: 'not a url' })).toThrow(/not a valid URL/);
    expect(() => parseRpcUrl({ RPC_URL: 'ftp://host' })).toThrow(/http/);
  });
});

describe('loadConfig', () => {
  it('assembles config from env and fails loud without DATABASE_URL', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://localhost/indexer' });
    expect(config.databaseUrl).toBe('postgres://localhost/indexer');
    expect(config.rpcUrl).toBe(DEFAULT_RPC_URL);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(() => loadConfig({})).toThrow(ConfigError);
  });
});
