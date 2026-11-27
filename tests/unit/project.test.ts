import { describe, expect, it } from 'vitest';
import type { RawEventRow } from '../../src/ingest/normalize.js';
import { asScript3CreatedPayload, projectProposal } from '../../src/ingest/project.js';
import type { DecodedEventRecord } from '../../src/parser/wasm.js';

const GOVERNOR = 'CCKGJBCBBYNWCMSBPV67DFIG3OL72RLDKNGHWJQCR5NASAUHOQRNLEDX';
const TREASURY = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

const RAW: RawEventRow = {
  ledger: 5_035_906,
  tx_hash: '34dd7cef8df6234f381563fff88b27a1163557f344f39832ff0e9901711215e3',
  op_index: 1,
  event_index: 0,
  contract_id: GOVERNOR,
  event_type: 'contract',
  ledger_closed_at: new Date('2026-10-05T12:25:17Z'),
  topics: ['AAAADwAAABBwcm9wb3NhbF9jcmVhdGVk', 'AAAAAwAAAAE='],
  value: 'AAAAEQ==',
  in_successful_contract_call: true,
  rpc_event_id: '0000000000000000000-0000000000',
  source: 'live',
};

/**
 * The `proposal_created` payload shape the pinned Script3 adapter emits
 * (`crates/core/src/adapters/script3.rs`, `normalize_event`). Kept inline
 * because this suite tests the projection, not the decoder — the decoder's
 * own differential tests live in the parser repository.
 */
function createdPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposal_id: 7,
    proposer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    title: 'Fund parser audit',
    description: 'Pay the auditor',
    action: {
      variant: 'calldata',
      contract_id: TREASURY,
      function: 'transfer',
      args: ['GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', TREASURY, '1000'],
      auths: [],
      amount_index: 2,
    },
    vote_start: 100,
    vote_end: 200,
    ...overrides,
  };
}

function decoded(
  normalized: unknown,
  decoding: 'VERIFIED' | 'UNVERIFIED' = 'VERIFIED',
): DecodedEventRecord {
  return {
    parserVersion: '0.1.0-alpha.2',
    governor: 'script3',
    topics: ['proposal_created'],
    payload: { normalized, rawTopics: RAW.topics, rawValue: RAW.value, source: 'live' },
    decoding,
  };
}

describe('projectProposal', () => {
  it('projects a verified proposal_created with parser-decoded, risk-classified calls', () => {
    const row = projectProposal(RAW, decoded(createdPayload()));
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      contract_id: GOVERNOR,
      governor: 'script3',
      proposal_id: '7',
      created_ledger: 5_035_906,
      created_tx_hash: RAW.tx_hash,
      proposer: createdPayload()['proposer'],
      title: 'Fund parser audit',
      decoding: 'VERIFIED',
      parser_version: '0.1.0-alpha.2',
    });
    expect(row?.calls).toHaveLength(1);
    expect(row?.calls[0]).toMatchObject({
      contract_id: TREASURY,
      function_name: 'transfer',
      // No target-contract spec was captured, so argument names stay unknown
      // and the call is explicitly unverified — never presented as decoded.
      decoding: 'unverified',
    });
    // Tier and rule are the parser's output, never this module's guess. With
    // no treasury/threshold configuration, no contextual rule fires.
    expect(row?.calls[0]?.risk).toEqual({
      tier: 'low',
      matched_rule: 'no contextual rule fired',
      verified: false,
    });
  });

  it('lets `self_call` fire from the governor id alone', () => {
    const row = projectProposal(
      RAW,
      decoded(
        createdPayload({
          action: {
            variant: 'calldata',
            contract_id: GOVERNOR,
            function: 'set_admin',
            args: ['GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'],
            auths: [],
            amount_index: null,
          },
        }),
      ),
    );
    expect(row?.calls[0]?.risk).toEqual({
      tier: 'high',
      matched_rule: 'self_call',
      verified: false,
    });
  });

  it('ignores events that are not verified, and events that are not proposal_created', () => {
    expect(projectProposal(RAW, decoded(createdPayload(), 'UNVERIFIED'))).toBeUndefined();
    expect(
      projectProposal(RAW, decoded({ proposal_id: 7, voter: 'G', support: 1, amount: '10' })),
    ).toBeUndefined();
  });

  it('keeps the proposal but marks it UNVERIFIED when the action cannot be decoded', () => {
    const row = projectProposal(
      RAW,
      decoded(createdPayload({ action: { variant: 'calldata' } })),
    );
    expect(row).toMatchObject({ proposal_id: '7', decoding: 'UNVERIFIED' });
    expect(row?.calls).toEqual([]);
  });

  it('rejects a half-shaped payload instead of guessing fields', () => {
    expect(asScript3CreatedPayload({ proposal_id: 7, title: 'no action' })).toBeUndefined();
    expect(
      asScript3CreatedPayload({ ...createdPayload(), proposal_id: '7' }),
    ).toBeUndefined();
  });
});
