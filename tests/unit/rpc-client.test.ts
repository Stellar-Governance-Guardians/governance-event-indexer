import { describe, expect, it } from 'vitest';
import {
  createRpcClient,
  parseGetEventsResult,
  parseHealthResult,
  parseRpcEvent,
  RpcError,
  type FetchLike,
} from '../../src/rpc/client.js';
import { RetryableError } from '../../src/rpc/backoff.js';

const noRetry = { retries: 0, baseMs: 1, capMs: 1, random: () => 0, sleep: async () => {} };

function rawEvent(ledger = 100, id = '001-0000000001'): Record<string, unknown> {
  return {
    type: 'contract',
    ledger,
    ledgerClosedAt: '2026-10-05T12:25:17Z',
    contractId: 'CDJWPKSQ4NA67PKTNJEPI6R2Q3JEDXPX5EDPM3YOSEHBDGBZ5THBTOKE',
    id,
    operationIndex: 0,
    transactionIndex: 0,
    txHash: 'ddef35404ed2fbef74c1e2324af631398aed9949ff2c7586d56d7cb17bfbea38',
    inSuccessfulContractCall: true,
    topic: ['AAAAAQ=='],
    value: 'AAAAAg==',
  };
}

function eventsBody(events: unknown[], cursor = 'tok-1'): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: {
      events,
      cursor,
      latestLedger: 200,
      oldestLedger: 1,
      latestLedgerCloseTime: '1791200807',
      oldestLedgerCloseTime: '1790596012',
    },
  });
}

const okFetch =
  (body: string): FetchLike =>
  async () => ({ ok: true, status: 200, text: async () => body });

describe('request shape', () => {
  it('sends filters/startLedger/endLedger/limit on the first page', async () => {
    const seen: { body?: string } = {};
    const client = createRpcClient('https://rpc.example', {
      fetchImpl: async (_url, init) => {
        seen.body = init.body;
        return { ok: true, status: 200, text: async () => eventsBody([rawEvent()]) };
      },
      backoff: noRetry,
    });
    await client.getEvents({
      contractIds: ['CID'],
      startLedger: 100,
      endLedger: 1099,
      limit: 500,
    });
    const req = JSON.parse(seen.body ?? '{}') as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(req.method).toBe('getEvents');
    expect(req.params).toEqual({
      filters: [{ type: 'contract', contractIds: ['CID'] }],
      limit: 500,
      startLedger: 100,
      endLedger: 1099,
    });
  });

  it('sends pagingToken only (no range) on follow-up pages', async () => {
    const seen: { body?: string } = {};
    const client = createRpcClient('https://rpc.example', {
      fetchImpl: async (_url, init) => {
        seen.body = init.body;
        return { ok: true, status: 200, text: async () => eventsBody([rawEvent()]) };
      },
      backoff: noRetry,
    });
    await client.getEvents({
      contractIds: ['CID'],
      startLedger: 100,
      endLedger: 1099,
      pagingToken: '002-0000000042',
      limit: 500,
    });
    const req = JSON.parse(seen.body ?? '{}') as { params: Record<string, unknown> };
    expect(req.params).toEqual({
      filters: [{ type: 'contract', contractIds: ['CID'] }],
      limit: 500,
      pagingToken: '002-0000000042',
    });
  });

  it('rejects empty contractIds and inverted ranges before any network call', async () => {
    const client = createRpcClient('https://rpc.example', {
      fetchImpl: async () => {
        throw new Error('must not be called');
      },
      backoff: noRetry,
    });
    expect(() => client.getEvents({ contractIds: [], startLedger: 1, endLedger: 2 })).toThrow(
      /contractIds must not be empty/,
    );
    expect(() => client.getEvents({ contractIds: ['C'], startLedger: 10, endLedger: 2 })).toThrow(
      /endLedger 2 < startLedger 10/,
    );
  });
});

describe('error classification', () => {
  it('retries HTTP 429/5xx and network failures, then succeeds', async () => {
    let calls = 0;
    const client = createRpcClient('https://rpc.example', {
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error('ECONNRESET');
        if (calls === 2) return { ok: false, status: 503, text: async () => 'unavailable' };
        return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { status: 'healthy', latestLedger: 10, oldestLedger: 1, ledgerRetentionWindow: 10 } }) };
      },
      backoff: { retries: 3, baseMs: 1, capMs: 2, random: () => 0, sleep: async () => {} },
    });
    const health = await client.getHealth();
    expect(health.latestLedger).toBe(10);
    expect(calls).toBe(3);
  });

  it('does not retry HTTP 4xx (fail closed)', async () => {
    let calls = 0;
    const client = createRpcClient('https://rpc.example', {
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 400, text: async () => 'bad' };
      },
      backoff: { retries: 3, baseMs: 1, capMs: 2, random: () => 0, sleep: async () => {} },
    });
    await expect(client.getHealth()).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);
  });

  it('retries server-range JSON-RPC errors (-32000..-32099), fails on the rest', async () => {
    let calls = 0;
    const serverErr = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: 'timeout' },
    });
    const client = createRpcClient('https://rpc.example', {
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, status: 200, text: async () => serverErr };
      },
      backoff: { retries: 2, baseMs: 1, capMs: 2, random: () => 0, sleep: async () => {} },
    });
    await expect(client.getHealth()).rejects.toThrow(RetryableError);
    expect(calls).toBe(3);

    let fatalCalls = 0;
    const fatal = createRpcClient('https://rpc.example', {
      fetchImpl: async () => {
        fatalCalls += 1;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid params' } }),
        };
      },
      backoff: { retries: 5, baseMs: 1, capMs: 2, random: () => 0, sleep: async () => {} },
    });
    await expect(fatal.getHealth()).rejects.toThrow(/-32602/);
    expect(fatalCalls).toBe(1);
  });

  it('treats non-JSON bodies as retryable and missing results as fatal', async () => {
    const retrying = createRpcClient('https://rpc.example', {
      fetchImpl: okFetch('<html>gateway</html>'),
      backoff: { retries: 1, baseMs: 1, capMs: 2, random: () => 0, sleep: async () => {} },
    });
    await expect(retrying.getHealth()).rejects.toThrow(/giving up after 2 attempts/);

    const fatal = createRpcClient('https://rpc.example', {
      fetchImpl: okFetch(JSON.stringify({ jsonrpc: '2.0', id: 1 })),
      backoff: noRetry,
    });
    await expect(fatal.getHealth()).rejects.toThrow(/neither result nor error/);
  });
});

describe('response validation', () => {
  it('parses a real-shaped getEvents result and rejects malformed ones', () => {
    const result = parseGetEventsResult(JSON.parse(eventsBody([rawEvent(100, 'x-5')])).result);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.id).toBe('x-5');
    expect(result.latestLedger).toBe(200);

    expect(() => parseGetEventsResult({ latestLedger: 1 })).toThrow(/events is not an array/);
    expect(() => parseGetEventsResult({ events: [], latestLedger: 1 })).toThrow(
      /oldestLedger/,
    );
    expect(() =>
      parseRpcEvent({ ...rawEvent(), topic: 'not-an-array' }, 0),
    ).toThrow(/array of base64 strings/);
    expect(() => parseRpcEvent({ ...rawEvent(), ledger: 'ten' }, 0)).toThrow(/invalid "ledger"/);
  });

  it('parses getHealth with the retention window', () => {
    const h = parseHealthResult({
      status: 'healthy',
      latestLedger: 5035284,
      oldestLedger: 4914325,
      ledgerRetentionWindow: 120960,
    });
    expect(h.ledgerRetentionWindow).toBe(120960);
    expect(() => parseHealthResult({ status: 'healthy' })).toThrow(/latestLedger/);
  });

  it('RpcError is thrown for protocol violations', () => {
    expect(() => parseHealthResult('nope')).toThrow(RpcError);
  });
});
