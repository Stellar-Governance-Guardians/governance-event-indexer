import { describe, expect, it } from 'vitest';
import { fetchWindowEvents, MAX_PAGES_PER_WINDOW } from '../../src/ingest/run.js';
import type {
  GetEventsParams,
  GetEventsResult,
  RpcEvent,
  SorobanRpcClient,
} from '../../src/rpc/client.js';

const CONTRACT = 'CDJWPKSQ4NA67PKTNJEPI6R2Q3JEDXPX5EDPM3YOSEHBDGBZ5THBTOKE';

function mkEvent(ledger: number, n: number, contractId = CONTRACT): RpcEvent {
  return {
    type: 'contract',
    ledger,
    ledgerClosedAt: '2026-10-05T12:25:17Z',
    contractId,
    id: `${String(ledger).padStart(19, '0')}-${String(n).padStart(10, '0')}`,
    operationIndex: 0,
    transactionIndex: 0,
    txHash: n.toString(16).padStart(64, 'a'),
    inSuccessfulContractCall: true,
    topic: ['AAAAAQ=='],
    value: 'AAAAAg==',
  };
}

/**
 * Deterministic in-memory RPC double. Paging semantics mirror the real RPC:
 * ranged call on page 1, token-only calls afterwards, `cursor` while events
 * remain. Returns events for OTHER contracts too, so the caller-side contract
 * filter gets exercised.
 */
function stubClient(all: RpcEvent[], opts: { fullPageNoCursor?: boolean } = {}): {
  client: SorobanRpcClient;
  calls: GetEventsParams[];
} {
  const calls: GetEventsParams[] = [];
  const client: SorobanRpcClient = {
    async getHealth() {
      return { status: 'healthy', latestLedger: 3000, oldestLedger: 1, ledgerRetentionWindow: 120960 };
    },
    async getEvents(params: GetEventsParams): Promise<GetEventsResult> {
      calls.push(params);
      const list = all
        .filter((e) => e.contractId === params.contractIds[0])
        .sort((a, b) => a.ledger - b.ledger || a.id.localeCompare(b.id));
      let idx: number;
      let ranged = true;
      if (params.pagingToken !== undefined) {
        idx = Number(params.pagingToken);
        ranged = false;
      } else {
        idx = list.findIndex((e) => e.ledger >= params.startLedger);
        if (idx < 0) idx = list.length;
      }
      const limit = params.limit ?? 500;
      const events: RpcEvent[] = [];
      while (
        idx < list.length &&
        events.length < limit &&
        (ranged ? list[idx]!.ledger <= params.endLedger : true)
      ) {
        events.push(list[idx]!);
        idx += 1;
      }
      const more = idx < list.length;
      const cursor = opts.fullPageNoCursor === true ? undefined : more ? String(idx) : undefined;
      return {
        events,
        cursor,
        latestLedger: 3000,
        oldestLedger: 1,
        latestLedgerCloseTime: '1791200807',
        oldestLedgerCloseTime: '1790596012',
      };
    },
  };
  return { client, calls };
}

describe('fetchWindowEvents', () => {
  it('pages until the window is drained and keeps only in-window, in-contract events', async () => {
    // 7 events in [10, 90], none beyond; limit 3 forces paging.
    const mine = [10, 20, 30, 40, 50, 60, 90].map((l, i) => mkEvent(l, i + 1));
    const { client, calls } = stubClient(mine);
    const { events, pages } = await fetchWindowEvents(client, {
      contractId: CONTRACT,
      fromLedger: 10,
      toLedger: 90,
      limit: 3,
    });
    expect(pages).toBeGreaterThan(1);
    expect(pages).toBe(calls.length);
    expect(events.map((e) => e.ledger)).toEqual([10, 20, 30, 40, 50, 60, 90]);
    // first call carries the range; follow-ups carry the paging token (the
    // RPC-client layer drops the range when a token is present — covered in
    // rpc-client.test.ts)
    expect(calls[0]).toMatchObject({ startLedger: 10, endLedger: 90 });
    expect(calls[1]).toMatchObject({ pagingToken: expect.any(String) });
  });

  it('stops at the window edge even if the RPC keeps returning beyond it', async () => {
    const mine = [10, 20, 30, 40, 50, 60, 70].map((l, i) => mkEvent(l, i + 1));
    const { client, calls } = stubClient(mine);
    const { events, pages } = await fetchWindowEvents(client, {
      contractId: CONTRACT,
      fromLedger: 10,
      toLedger: 40,
      limit: 3,
    });
    expect(events.map((e) => e.ledger)).toEqual([10, 20, 30, 40]);
    expect(pages).toBe(2); // third page would hold events > 40: stopped after seeing them
    expect(calls).toHaveLength(2);
  });

  it('drops events for other contracts (defensive filter)', async () => {
    const foreign = 'CAQCXFI6YSXWGCB37PRZVG5YNLLJMY45IWLUUTFMTXFIAF2MOZ5DMGJ7';
    const client: SorobanRpcClient = {
      async getHealth() {
        return { status: 'healthy', latestLedger: 3000, oldestLedger: 1, ledgerRetentionWindow: 120960 };
      },
      async getEvents() {
        return {
          events: [mkEvent(10, 1, foreign)],
          cursor: undefined,
          latestLedger: 3000,
          oldestLedger: 1,
          latestLedgerCloseTime: '1791200807',
          oldestLedgerCloseTime: '1790596012',
        };
      },
    };
    const { events, pages } = await fetchWindowEvents(client, {
      contractId: CONTRACT,
      fromLedger: 1,
      toLedger: 100,
      limit: 500,
    });
    expect(events).toEqual([]);
    expect(pages).toBe(1);
  });

  it('fails loud when a full page arrives without a paging cursor', async () => {
    const mine = [10, 20, 30].map((l, i) => mkEvent(l, i + 1));
    const { client } = stubClient(mine, { fullPageNoCursor: true });
    await expect(
      fetchWindowEvents(client, { contractId: CONTRACT, fromLedger: 1, toLedger: 100, limit: 3 }),
    ).rejects.toThrow(/no paging cursor/);
  });

  it('has a fail-loud page bound', () => {
    expect(MAX_PAGES_PER_WINDOW).toBeGreaterThan(0);
    expect(MAX_PAGES_PER_WINDOW).toBeLessThanOrEqual(10_000);
  });
});
