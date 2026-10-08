/**
 * Soroban JSON-RPC client (I2). The ONLY network code in the live ingestion
 * path. Offline tests inject `fetchImpl`; the PR gate never calls it.
 *
 * Request/response shapes are pinned by committed raw RPC captures in the
 * parser repo (its getEvents and getHealth captures — provenance cited in
 * this repo's fixture provenance ledger under the test tree).
 */

import { RetryableError, withBackoff, type BackoffInput } from './backoff.js';

export interface RpcEvent {
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  /** RPC event id: `<tx position>-<event sequence>`; the suffix is event_index. */
  id: string;
  operationIndex: number;
  transactionIndex: number;
  txHash: string;
  inSuccessfulContractCall: boolean;
  /** Base64-encoded ScVal topics, verbatim from the RPC. */
  topic: string[];
  /** Base64-encoded ScVal, verbatim from the RPC. */
  value: string;
}

export interface GetEventsResult {
  events: RpcEvent[];
  cursor: string | undefined;
  latestLedger: number;
  oldestLedger: number;
  latestLedgerCloseTime: string;
  oldestLedgerCloseTime: string;
}

export interface HealthResult {
  status: string;
  latestLedger: number;
  oldestLedger: number;
  ledgerRetentionWindow: number;
}

export interface GetEventsParams {
  contractIds: readonly string[];
  /** First page: startLedger + endLedger (window <= 1000 ledgers, enforced by caller). */
  startLedger: number;
  endLedger: number;
  /** Follow-up pages: RPC paging token from the previous response. */
  pagingToken?: string;
  limit?: number;
}

export interface SorobanRpcClient {
  getHealth(): Promise<HealthResult>;
  getEvents(params: GetEventsParams): Promise<GetEventsResult>;
}

export class RpcError extends Error {
  override readonly name = 'RpcError';
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface CreateClientOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  backoff?: BackoffInput;
  /** For tests: idempotency counter for JSON-RPC ids. */
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireNumber(obj: Record<string, unknown>, key: string, ctx: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new RpcError(`${ctx}: missing/invalid "${key}" (got ${JSON.stringify(v)})`);
  }
  return v;
}

function requireString(obj: Record<string, unknown>, key: string, ctx: string): string {
  const v = obj[key];
  if (typeof v !== 'string') {
    throw new RpcError(`${ctx}: missing/invalid "${key}" (got ${JSON.stringify(v)})`);
  }
  return v;
}

/** Validate one raw RPC event entry; fail loud, never coerce. */
export function parseRpcEvent(raw: unknown, index: number): RpcEvent {
  const ctx = `getEvents result.events[${index}]`;
  if (!isRecord(raw)) throw new RpcError(`${ctx}: not an object`);
  const topic = raw['topic'];
  if (!Array.isArray(topic) || topic.some((t) => typeof t !== 'string')) {
    throw new RpcError(`${ctx}: "topic" must be an array of base64 strings`);
  }
  return {
    type: requireString(raw, 'type', ctx),
    ledger: requireNumber(raw, 'ledger', ctx),
    ledgerClosedAt: requireString(raw, 'ledgerClosedAt', ctx),
    contractId: requireString(raw, 'contractId', ctx),
    id: requireString(raw, 'id', ctx),
    operationIndex: requireNumber(raw, 'operationIndex', ctx),
    transactionIndex: requireNumber(raw, 'transactionIndex', ctx),
    txHash: requireString(raw, 'txHash', ctx),
    inSuccessfulContractCall: (() => {
      const v = raw['inSuccessfulContractCall'];
      if (typeof v !== 'boolean') throw new RpcError(`${ctx}: "inSuccessfulContractCall" must be boolean`);
      return v;
    })(),
    topic: topic as string[],
    value: requireString(raw, 'value', ctx),
  };
}

export function parseGetEventsResult(result: unknown): GetEventsResult {
  if (!isRecord(result)) throw new RpcError('getEvents: result is not an object');
  const eventsRaw = result['events'];
  if (!Array.isArray(eventsRaw)) throw new RpcError('getEvents: result.events is not an array');
  const cursor = result['cursor'];
  return {
    events: eventsRaw.map(parseRpcEvent),
    cursor: typeof cursor === 'string' ? cursor : undefined,
    latestLedger: requireNumber(result, 'latestLedger', 'getEvents'),
    oldestLedger: requireNumber(result, 'oldestLedger', 'getEvents'),
    latestLedgerCloseTime: requireString(result, 'latestLedgerCloseTime', 'getEvents'),
    oldestLedgerCloseTime: requireString(result, 'oldestLedgerCloseTime', 'getEvents'),
  };
}

export function parseHealthResult(result: unknown): HealthResult {
  if (!isRecord(result)) throw new RpcError('getHealth: result is not an object');
  return {
    status: requireString(result, 'status', 'getHealth'),
    latestLedger: requireNumber(result, 'latestLedger', 'getHealth'),
    oldestLedger: requireNumber(result, 'oldestLedger', 'getHealth'),
    ledgerRetentionWindow: requireNumber(result, 'ledgerRetentionWindow', 'getHealth'),
  };
}

/** JSON-RPC error codes in the server range are transient by spec. */
function rpcErrorRetryable(code: number): boolean {
  return code <= -32000 && code >= -32099;
}

export function createRpcClient(url: string, options: CreateClientOptions = {}): SorobanRpcClient {
  const fetchImpl: FetchLike =
    options.fetchImpl ??
    (async (u, init) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const res = await fetch(u, { ...init, signal: controller.signal });
        return { ok: res.ok, status: res.status, text: () => res.text() };
      } finally {
        clearTimeout(timer);
      }
    });
  let nextId = options.now?.() ?? 1;

  async function call<T>(
    method: string,
    params: Record<string, unknown>,
    parse: (result: unknown) => T,
  ): Promise<T> {
    const id = nextId++;
    let text: string;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      if (!res.ok) {
        // 429 and 5xx are transient; everything else is a client error.
        if (res.status === 429 || res.status >= 500) {
          throw new RetryableError(`${method}: HTTP ${res.status}`);
        }
        throw new RpcError(`${method}: HTTP ${res.status}`);
      }
      text = await res.text();
    } catch (err) {
      if (err instanceof RetryableError || err instanceof RpcError) throw err;
      // fetch TypeError / abort — network trouble, retryable.
      throw new RetryableError(`${method}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RetryableError(`${method}: response is not JSON (${text.slice(0, 120)})`);
    }
    if (!isRecord(body)) throw new RpcError(`${method}: response is not an object`);
    if (body['error'] !== undefined && body['error'] !== null) {
      const e = body['error'];
      if (!isRecord(e)) throw new RpcError(`${method}: malformed error object`);
      const code = typeof e['code'] === 'number' ? e['code'] : 0;
      const message = `${method}: RPC error ${code} ${String(e['message'])}`;
      if (rpcErrorRetryable(code)) throw new RetryableError(message);
      throw new RpcError(message);
    }
    if (body['result'] === undefined) throw new RpcError(`${method}: response has neither result nor error`);
    return parse(body['result']);
  }

  return {
    getHealth(): Promise<HealthResult> {
      return withBackoff(() => call('getHealth', {}, parseHealthResult), options.backoff);
    },
    getEvents(params: GetEventsParams): Promise<GetEventsResult> {
      if (params.contractIds.length === 0) {
        throw new RpcError('getEvents: contractIds must not be empty');
      }
      if (params.endLedger < params.startLedger) {
        throw new RpcError(
          `getEvents: endLedger ${params.endLedger} < startLedger ${params.startLedger}`,
        );
      }
      const rpcParams: Record<string, unknown> = {
        filters: [{ type: 'contract', contractIds: [...params.contractIds] }],
        limit: params.limit ?? 500,
      };
      if (params.pagingToken !== undefined) {
        // Paging: token only — startLedger/endLedger are mutually exclusive
        // with paging on the RPC; the caller re-applies the window bound.
        rpcParams['pagingToken'] = params.pagingToken;
      } else {
        rpcParams['startLedger'] = params.startLedger;
        rpcParams['endLedger'] = params.endLedger;
      }
      return withBackoff(() => call('getEvents', rpcParams, parseGetEventsResult), options.backoff);
    },
  };
}
