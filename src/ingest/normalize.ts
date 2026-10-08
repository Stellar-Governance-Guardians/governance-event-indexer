/**
 * Raw-event normalization (I2). THE shared code path: live ingestion and
 * fixture replay both funnel every RPC event through `toRawEventRow`, so a
 * replayed historical event and a freshly ingested one differ only in the
 * `source` tag — never in shape.
 *
 * Fail loud: a malformed event is an Error with context, never a coerced row.
 */

import type { EventSource } from '../db/index.js';
import type { RpcEvent } from '../rpc/client.js';

export interface RawEventRow {
  ledger: number;
  tx_hash: string;
  op_index: number;
  event_index: number;
  contract_id: string;
  event_type: string;
  ledger_closed_at: Date | null;
  topics: string[];
  value: string;
  in_successful_contract_call: boolean;
  rpc_event_id: string;
  source: EventSource;
}

/**
 * Event index from the RPC event id: `<position>-<sequence>`. The sequence
 * suffix is the RPC's own ordering counter, so re-fetching the same event
 * yields the same key (idempotency) and two events in the same
 * (ledger, tx, op) group never collide.
 */
export function eventIndexFromId(id: string): number {
  const match = /-(\d+)$/.exec(id);
  if (match === null) {
    throw new Error(
      `cannot derive event_index: RPC event id "${id}" has no <position>-<sequence> suffix`,
    );
  }
  const n = Number(match[1]);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`cannot derive event_index: suffix of "${id}" is not a safe non-negative integer`);
  }
  return n;
}

export function toRawEventRow(event: RpcEvent, source: EventSource): RawEventRow {
  if (!Number.isSafeInteger(event.ledger) || event.ledger < 0) {
    throw new Error(`event ${event.id}: invalid ledger ${event.ledger}`);
  }
  if (!Number.isSafeInteger(event.operationIndex) || event.operationIndex < 0) {
    throw new Error(`event ${event.id}: invalid operationIndex ${event.operationIndex}`);
  }
  if (event.txHash === '' || !/^[0-9a-f]{64}$/.test(event.txHash)) {
    throw new Error(`event ${event.id}: txHash is not a 64-char hex string: ${event.txHash}`);
  }
  if (event.contractId === '') {
    throw new Error(`event ${event.id}: empty contractId`);
  }

  let ledgerClosedAt: Date | null = null;
  if (event.ledgerClosedAt !== '') {
    const d = new Date(event.ledgerClosedAt);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`event ${event.id}: ledgerClosedAt is not an ISO timestamp: ${event.ledgerClosedAt}`);
    }
    ledgerClosedAt = d;
  }

  return {
    ledger: event.ledger,
    tx_hash: event.txHash,
    op_index: event.operationIndex,
    event_index: eventIndexFromId(event.id),
    contract_id: event.contractId,
    event_type: event.type,
    ledger_closed_at: ledgerClosedAt,
    topics: [...event.topic],
    value: event.value,
    in_successful_contract_call: event.inSuccessfulContractCall,
    rpc_event_id: event.id,
    source,
  };
}
