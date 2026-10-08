import { describe, expect, it } from 'vitest';
import { eventIndexFromId, toRawEventRow } from '../../src/ingest/normalize.js';
import type { RpcEvent } from '../../src/rpc/client.js';

const TX = '34dd7cef8df6234f381563fff88b27a1163557f344f39832ff0e9901711215e3';

function mkEvent(overrides: Partial<RpcEvent> = {}): RpcEvent {
  return {
    type: 'contract',
    ledger: 5035906,
    ledgerClosedAt: '2026-10-05T12:25:17Z',
    contractId: 'CDJWPKSQ4NA67PKTNJEPI6R2Q3JEDXPX5EDPM3YOSEHBDGBZ5THBTOKE',
    id: '0021629051575758848-0000000007',
    operationIndex: 0,
    transactionIndex: 7,
    txHash: TX,
    inSuccessfulContractCall: true,
    topic: ['AAAADwAAABBwcm9wb3NhbF9jcmVhdGVk'],
    value: 'AAAAEAAAAAEAAAACAAAADgAAABFGdW5kIHBhcnNlciBhdWRpdAAAAAAAAAkAAAAAAAAAAAAAAAAAD0JA',
    ...overrides,
  };
}

describe('eventIndexFromId', () => {
  it('parses the sequence suffix of the RPC event id', () => {
    expect(eventIndexFromId('0021629051575758848-0000000007')).toBe(7);
    expect(eventIndexFromId('000-0')).toBe(0);
    expect(eventIndexFromId('abc-4294967295')).toBe(4294967295);
  });

  it('fails loud on ids without a numeric suffix', () => {
    expect(() => eventIndexFromId('no-suffix-here')).toThrow(/cannot derive event_index/);
    expect(() => eventIndexFromId('')).toThrow(/cannot derive event_index/);
    expect(() => eventIndexFromId('pos-not-a-number')).toThrow(/cannot derive event_index/);
  });
});

describe('toRawEventRow', () => {
  it('produces the storage row verbatim, tagged with its source', () => {
    const row = toRawEventRow(mkEvent(), 'live');
    expect(row).toEqual({
      ledger: 5035906,
      tx_hash: TX,
      op_index: 0,
      event_index: 7,
      contract_id: 'CDJWPKSQ4NA67PKTNJEPI6R2Q3JEDXPX5EDPM3YOSEHBDGBZ5THBTOKE',
      event_type: 'contract',
      ledger_closed_at: new Date('2026-10-05T12:25:17Z'),
      topics: ['AAAADwAAABBwcm9wb3NhbF9jcmVhdGVk'],
      value: 'AAAAEAAAAAEAAAACAAAADgAAABFGdW5kIHBhcnNlciBhdWRpdAAAAAAAAAkAAAAAAAAAAAAAAAAAD0JA',
      in_successful_contract_call: true,
      rpc_event_id: '0021629051575758848-0000000007',
      source: 'live',
    });
    const replay = toRawEventRow(mkEvent(), 'fixture-replay');
    expect(replay.source).toBe('fixture-replay');
    // Same event, both sources: identical except the tag (never mixed shapes).
    expect({ ...replay, source: 'live' }).toEqual(row);
  });

  it('fails loud on malformed events instead of coercing', () => {
    expect(() => toRawEventRow(mkEvent({ ledger: -1 }), 'live')).toThrow(/invalid ledger/);
    expect(() => toRawEventRow(mkEvent({ operationIndex: -2 }), 'live')).toThrow(/invalid operationIndex/);
    expect(() => toRawEventRow(mkEvent({ txHash: 'nope' }), 'live')).toThrow(/64-char hex/);
    expect(() => toRawEventRow(mkEvent({ contractId: '' }), 'live')).toThrow(/empty contractId/);
    expect(() => toRawEventRow(mkEvent({ ledgerClosedAt: 'not-a-date' }), 'live')).toThrow(
      /not an ISO timestamp/,
    );
    expect(() => toRawEventRow(mkEvent({ id: 'broken' }), 'live')).toThrow(/event_index/);
  });

  it('allows an empty ledgerClosedAt as null (absence is meaningful)', () => {
    expect(toRawEventRow(mkEvent({ ledgerClosedAt: '' }), 'live').ledger_closed_at).toBeNull();
  });
});
