/**
 * Proposal projection (I5): turn a verified `proposal_created` decode record
 * into the row the `proposal` GraphQL field reads.
 *
 * Pure and fail-loud-at-the-boundary: it never guesses a proposal id, a
 * proposer or a risk tier. If the pinned parser cannot decode the stored
 * action into calls, the row is kept as UNVERIFIED with an empty call list —
 * dropping it would turn a decode failure into "proposal does not exist".
 *
 * It consumes the same `decoded_events` record every other read path uses, so
 * live ingestion and fixture replay produce identical projections.
 */

import type { RawEventRow } from './normalize.js';
import {
  decodeScript3Proposal,
  type DecodedCallJson,
  type DecodedEventRecord,
} from '../parser/wasm.js';

export interface ProposalProjection {
  contract_id: string;
  governor: string;
  proposal_id: string;
  created_ledger: number;
  created_tx_hash: string;
  proposer: string | null;
  title: string | null;
  calls: DecodedCallJson[];
  decoding: 'VERIFIED' | 'UNVERIFIED';
  parser_version: string;
}

interface Script3CreatedPayload {
  proposal_id: number;
  proposer: string;
  title: string;
  description: string;
  action: unknown;
  vote_start: number;
  vote_end: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural check for a Script3 `proposal_created` payload. Deliberately
 * structural rather than name-based: the decoded payload is the parser's
 * documented output shape, and a missing field must not half-project.
 */
export function asScript3CreatedPayload(value: unknown): Script3CreatedPayload | undefined {
  if (!isRecord(value)) return undefined;
  const {
    proposal_id: proposalId,
    proposer,
    title,
    description,
    action,
    vote_start: voteStart,
    vote_end: voteEnd,
  } = value;
  if (typeof proposalId !== 'number' || !Number.isSafeInteger(proposalId) || proposalId < 0) {
    return undefined;
  }
  if (typeof proposer !== 'string' || proposer === '') return undefined;
  if (typeof title !== 'string' || typeof description !== 'string') return undefined;
  if (typeof voteStart !== 'number' || typeof voteEnd !== 'number') return undefined;
  if (action === undefined) return undefined;
  return {
    proposal_id: proposalId,
    proposer,
    title,
    description,
    action,
    vote_start: voteStart,
    vote_end: voteEnd,
  };
}

/**
 * Project one stored decode record. Returns `undefined` unless the event is a
 * VERIFIED Script3 `proposal_created` — everything else belongs to another
 * projection (votes, delegates) or stays in `decoded_events` only.
 */
export function projectProposal(
  raw: RawEventRow,
  decoded: DecodedEventRecord,
): ProposalProjection | undefined {
  if (decoded.decoding !== 'VERIFIED') return undefined;
  const payload = isRecord(decoded.payload) ? decoded.payload['normalized'] : undefined;
  const created = asScript3CreatedPayload(payload);
  if (created === undefined) return undefined;

  let calls: DecodedCallJson[] = [];
  let decoding: 'VERIFIED' | 'UNVERIFIED' = 'UNVERIFIED';
  try {
    const proposal = decodeScript3Proposal(
      {
        proposal_id: created.proposal_id,
        title: created.title,
        description: created.description,
        creator: created.proposer,
        action: created.action,
        vote_start: created.vote_start,
        vote_end: created.vote_end,
      },
      // The governor id is the one contextual input the event stream actually
      // determines: it lets `self_call` fire when a proposal targets the
      // governor itself. Treasury addresses and a value threshold are operator
      // configuration the indexer does not have, so they are not invented.
      JSON.stringify({ governor: raw.contract_id }),
    );
    calls = proposal.calls;
    decoding = proposal.decoding === 'verified' ? 'VERIFIED' : 'UNVERIFIED';
  } catch {
    // The event itself verified; only the action→calls projection failed.
    // Keep the proposal with an explicit UNVERIFIED status instead of
    // pretending no such proposal was created.
    calls = [];
    decoding = 'UNVERIFIED';
  }

  return {
    contract_id: raw.contract_id,
    governor: decoded.governor,
    proposal_id: String(created.proposal_id),
    created_ledger: raw.ledger,
    created_tx_hash: raw.tx_hash,
    proposer: created.proposer,
    title: created.title,
    calls,
    decoding,
    parser_version: decoded.parserVersion,
  };
}
