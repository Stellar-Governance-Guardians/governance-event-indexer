import { describe, expect, it } from 'vitest';
import { encodeCursor, parseCursor } from '../../src/graphql/server.js';

/**
 * Keyset cursors replaced LIMIT/OFFSET because concurrent ingestion inserts
 * rows behind the reader. The cursor must round-trip the exact key and reject
 * everything else — a cursor that silently degrades to an offset would make
 * pages repeat or skip rows under ingest.
 */
describe('event keyset cursor', () => {
  it('round-trips the full (ledger, tx_hash, op_index, event_index) key', () => {
    const cursor = { ledger: 5035906, txHash: 'a'.repeat(64), opIndex: 2, eventIndex: 7 };
    expect(parseCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('is opaque base64url, not a readable offset', () => {
    const encoded = encodeCursor({ ledger: 42, txHash: 'b'.repeat(64), opIndex: 0, eventIndex: 0 });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toBe('42');
  });

  it('returns undefined for an absent or empty cursor', () => {
    expect(parseCursor(null)).toBeUndefined();
    expect(parseCursor(undefined)).toBeUndefined();
    expect(parseCursor('')).toBeUndefined();
  });

  it('rejects tuples that are not a complete event key', () => {
    expect(() => parseCursor('not-base64-json')).toThrow(/not a valid event cursor/);
    // Offsets from the previous implementation must not be accepted.
    expect(() => parseCursor(Buffer.from('12', 'utf8').toString('base64url'))).toThrow(
      /not a valid event cursor/,
    );
    // Three elements (missing event_index).
    expect(() =>
      parseCursor(Buffer.from(JSON.stringify([1, 'x', 0]), 'utf8').toString('base64url')),
    ).toThrow(/not a valid event cursor/);
    // Empty tx hash and negative ledger.
    expect(() =>
      parseCursor(Buffer.from(JSON.stringify([1, '', 0, 0]), 'utf8').toString('base64url')),
    ).toThrow(/not a valid event cursor/);
    expect(() =>
      parseCursor(Buffer.from(JSON.stringify([-1, 'x', 0, 0]), 'utf8').toString('base64url')),
    ).toThrow(/not a valid event cursor/);
  });
});
