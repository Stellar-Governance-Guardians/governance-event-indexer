import { createRequire } from 'node:module';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

interface ParserWasm {
  matches_event(contractId: string, ledger: number, txHash: string, topicsJson: string, value: string): boolean;
  normalize_event(contractId: string, ledger: number, txHash: string, topicsJson: string, value: string): string;
}

export interface NormalizedGraphqlEvent {
  governor: string;
  topics: string[];
  ledger: number;
  txHash: string;
  contractId: string;
  payload: Record<string, unknown>;
  decoding: 'VERIFIED' | 'UNVERIFIED';
}

let parser: ParserWasm | undefined;
let pinnedVersion: string | undefined;

export function parserVersion(): string {
  pinnedVersion ??= (JSON.parse(readFileSync(join(process.cwd(), 'parser.lock'), 'utf8')) as { version: string }).version;
  return pinnedVersion;
}

function loadParser(): ParserWasm {
  parser ??= createRequire(import.meta.url)(
    join(process.cwd(), 'generated', 'parser', 'nodejs', 'sgp_parser_wasm.js'),
  ) as ParserWasm;
  return parser;
}

function unverified(row: {
  contractId: string;
  ledger: number;
  txHash: string;
  topics: string[];
  value: string;
  source: string;
}, reason: string): NormalizedGraphqlEvent {
  return {
    governor: 'unverified',
    topics: row.topics,
    ledger: row.ledger,
    txHash: row.txHash,
    contractId: row.contractId,
    payload: {
      rawTopics: row.topics,
      rawValue: row.value,
      source: row.source,
      reason,
    },
    decoding: 'UNVERIFIED',
  };
}

/**
 * Normalize through the pinned parser artifact. Any missing artifact, unknown
 * governor, malformed XDR, or unsupported event shape remains explicitly
 * unverified with the original payload and provenance intact.
 */
export function normalizeStoredEvent(row: {
  contractId: string;
  ledger: number;
  txHash: string;
  topics: string[];
  value: string;
  source: string;
}): NormalizedGraphqlEvent {
  try {
    const adapter = loadParser();
    const topicsJson = JSON.stringify(row.topics);
    if (!adapter.matches_event(row.contractId, row.ledger, row.txHash, topicsJson, row.value)) {
      return unverified(row, 'no pinned governor adapter matched this event');
    }
    const decoded = JSON.parse(
      adapter.normalize_event(row.contractId, row.ledger, row.txHash, topicsJson, row.value),
    ) as { governor: string; topics: string[]; ledger: number; tx_hash: string; contract_id: string; payload: unknown; decoding: 'verified' | 'unverified' };
    return {
      governor: decoded.governor,
      topics: decoded.topics,
      ledger: decoded.ledger,
      txHash: decoded.tx_hash,
      contractId: decoded.contract_id,
      payload: { normalized: decoded.payload, rawTopics: row.topics, rawValue: row.value, source: row.source },
      decoding: decoded.decoding === 'verified' ? 'VERIFIED' : 'UNVERIFIED',
    };
  } catch (error) {
    return unverified(row, `pinned parser normalization failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface DecodedEventRecord {
  parserVersion: string;
  governor: string;
  topics: string[];
  payload: Record<string, unknown>;
  decoding: 'VERIFIED' | 'UNVERIFIED';
}

export function decodeStoredEvent(row: Parameters<typeof normalizeStoredEvent>[0]): DecodedEventRecord {
  const normalized = normalizeStoredEvent(row);
  return {
    parserVersion: parserVersion(),
    governor: normalized.governor,
    topics: normalized.topics,
    payload: normalized.payload,
    decoding: normalized.decoding,
  };
}
