import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ClassifiedResult,
  DroppedResult,
  ErrorResult,
  UnclassifiedAppResult,
  UnclassifiedTypeResult,
} from '../classifier/types';

import {
  findOrCreateTicket,
  TicketEngineNotApplicableError,
  TicketEngineNotFoundError,
  TicketEngineRaceError,
  TicketEngineValidationError,
} from './engine';
import type { TicketRow } from './types';

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));

vi.mock('../db', () => ({
  storeDb: () => ({ rpc: mockRpc }),
}));

// -- Fixtures ------------------------------------------------------------

function baseTicket(overrides: Partial<TicketRow> = {}): TicketRow {
  return {
    id: 'ticket-abc',
    display_id: 'T-0001',
    app_id: 'app-tft',
    platform_id: 'platform-apple',
    type_id: 'type-approved',
    state: 'NEW',
    latest_outcome: 'APPROVED',
    priority: 'NORMAL',
    assigned_to: null,
    type_payloads: [],
    submission_ids: ['sub-123'],
    opened_at: '2026-04-23T00:00:00Z',
    closed_at: null,
    resolution_type: null,
    due_date: null,
    created_at: '2026-04-23T00:00:00Z',
    updated_at: '2026-04-23T00:00:00Z',
    ...overrides,
  };
}

function rpcCreated(ticketOverrides: Partial<TicketRow> = {}) {
  return {
    data: {
      ticket_id: 'ticket-abc',
      created: true,
      previous_state: null,
      new_state: 'NEW',
      state_changed: false,
      ticket: baseTicket(ticketOverrides),
    },
    error: null,
  };
}

function rpcUpdated(opts: {
  prev: TicketRow['state'];
  next: TicketRow['state'];
  ticketOverrides?: Partial<TicketRow>;
}) {
  // When transitioning to APPROVED (terminal), auto-populate closed_at +
  // resolution_type so the mocked row satisfies invariant #6 (CLAUDE.md).
  // This mirrors the RPC's behavior at migration lines 362-372.
  const terminalFields: Partial<TicketRow> =
    opts.next === 'APPROVED'
      ? {
          closed_at: '2026-04-23T00:00:00Z',
          resolution_type: 'APPROVED',
        }
      : {};

  return {
    data: {
      ticket_id: 'ticket-abc',
      created: false,
      previous_state: opts.prev,
      new_state: opts.next,
      state_changed: opts.prev !== opts.next,
      ticket: baseTicket({
        state: opts.next,
        ...terminalFields,
        ...opts.ticketOverrides,
      }),
    },
    error: null,
  };
}

/**
 * Build a CLASSIFIED classification with outcome override. Used for matrix
 * rows that test specific outcome values (including null — a spec-legal
 * path per §4.1 even though classifier types make outcome required in
 * practice).
 */
function classifiedWithOutcome(
  outcome: 'IN_REVIEW' | 'REJECTED' | 'APPROVED' | null,
): ClassifiedResult {
  return { ...classified(), outcome: outcome as ClassifiedResult['outcome'] };
}

function classified(): ClassifiedResult {
  return {
    status: 'CLASSIFIED',
    platform_id: 'platform-apple',
    app_id: 'app-tft',
    type_id: 'type-approved',
    outcome: 'APPROVED',
    type_payload: {},
    submission_id: 'sub-123',
    extracted_app_name: 'TFT',
    matched_rules: [],
  };
}

function unclassifiedApp(): UnclassifiedAppResult {
  return {
    status: 'UNCLASSIFIED_APP',
    platform_id: 'platform-apple',
    outcome: 'APPROVED',
    extracted_app_name: 'Mystery App',
    matched_rules: [],
  };
}

function unclassifiedType(): UnclassifiedTypeResult {
  return {
    status: 'UNCLASSIFIED_TYPE',
    platform_id: 'platform-apple',
    app_id: 'app-tft',
    outcome: 'APPROVED',
    extracted_app_name: 'TFT',
    matched_rules: [],
  };
}

beforeEach(() => {
  mockRpc.mockReset();
});

afterEach(() => {
  vi.resetAllMocks();
});

// -- Defense-in-depth gate -----------------------------------------------

describe('findOrCreateTicket — defense-in-depth gate', () => {
  it('throws TicketEngineNotApplicableError for DROPPED (never calls RPC)', async () => {
    const dropped: DroppedResult = {
      status: 'DROPPED',
      reason: 'NO_SENDER_MATCH',
    };

    await expect(
      findOrCreateTicket({
        emailMessageId: 'email-1',
        classification: dropped as unknown as UnclassifiedAppResult,
      }),
    ).rejects.toBeInstanceOf(TicketEngineNotApplicableError);

    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('throws TicketEngineNotApplicableError for ERROR (never calls RPC)', async () => {
    const error: ErrorResult = {
      status: 'ERROR',
      error_code: 'PARSE_ERROR',
      error_message: 'boom',
      matched_rules: [],
    };

    await expect(
      findOrCreateTicket({
        emailMessageId: 'email-2',
        classification: error as unknown as UnclassifiedAppResult,
      }),
    ).rejects.toBeInstanceOf(TicketEngineNotApplicableError);

    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// -- Happy paths ---------------------------------------------------------

describe('findOrCreateTicket — happy paths', () => {
  it('CLASSIFIED (create path) returns new ticket with state=NEW', async () => {
    mockRpc.mockResolvedValueOnce(rpcCreated());

    const out = await findOrCreateTicket({
      emailMessageId: 'email-1',
      classification: classified(),
    });

    expect(out.ticketId).toBe('ticket-abc');
    expect(out.created).toBe(true);
    expect(out.new_state).toBe('NEW');
    expect(out.previous_state).toBeNull();
    expect(out.state_changed).toBe(false);
    expect(out.ticket?.state).toBe('NEW');
  });

  it('CLASSIFIED (update path, REJECTED → APPROVED) returns state transition', async () => {
    mockRpc.mockResolvedValueOnce(
      rpcUpdated({ prev: 'REJECTED', next: 'APPROVED' }),
    );

    const out = await findOrCreateTicket({
      emailMessageId: 'email-1',
      classification: classified(),
    });

    expect(out.created).toBe(false);
    expect(out.previous_state).toBe('REJECTED');
    expect(out.new_state).toBe('APPROVED');
    expect(out.state_changed).toBe(true);
    expect(out.ticket?.state).toBe('APPROVED');
  });

  it('CLASSIFIED (update path, NEW stays NEW) — no transition', async () => {
    mockRpc.mockResolvedValueOnce(
      rpcUpdated({ prev: 'NEW', next: 'NEW' }),
    );

    const out = await findOrCreateTicket({
      emailMessageId: 'email-1',
      classification: classified(),
    });

    expect(out.created).toBe(false);
    expect(out.state_changed).toBe(false);
    expect(out.previous_state).toBe('NEW');
    expect(out.new_state).toBe('NEW');
  });

  it('UNCLASSIFIED_APP — bucket ticket (app_id null)', async () => {
    mockRpc.mockResolvedValueOnce(
      rpcCreated({ app_id: null, type_id: null }),
    );

    const out = await findOrCreateTicket({
      emailMessageId: 'email-2',
      classification: unclassifiedApp(),
    });

    expect(out.created).toBe(true);
    expect(out.ticket?.app_id).toBeNull();
    expect(out.ticket?.type_id).toBeNull();
  });

  it('UNCLASSIFIED_TYPE — bucket ticket (type_id null, app_id set)', async () => {
    mockRpc.mockResolvedValueOnce(rpcCreated({ type_id: null }));

    const out = await findOrCreateTicket({
      emailMessageId: 'email-3',
      classification: unclassifiedType(),
    });

    expect(out.created).toBe(true);
    expect(out.ticket?.app_id).toBe('app-tft');
    expect(out.ticket?.type_id).toBeNull();
  });

  it('passes p_classification + p_email_message_id to RPC', async () => {
    mockRpc.mockResolvedValueOnce(rpcCreated());

    const c = classified();
    await findOrCreateTicket({
      emailMessageId: 'email-1',
      classification: c,
    });

    expect(mockRpc).toHaveBeenCalledWith('find_or_create_ticket_tx', {
      p_classification: c,
      p_email_message_id: 'email-1',
    });
  });
});

// -- RPC error mapping ---------------------------------------------------

describe('findOrCreateTicket — RPC error mapping', () => {
  it('INVALID_STATUS → TicketEngineValidationError', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'INVALID_STATUS: classification.status must be ticketable (got FOO)' },
    });

    await expect(
      findOrCreateTicket({
        emailMessageId: 'email-1',
        classification: classified(),
      }),
    ).rejects.toBeInstanceOf(TicketEngineValidationError);
  });

  it('INVALID_ARG → TicketEngineValidationError', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'INVALID_ARG: classification.platform_id must be UUID' },
    });

    await expect(
      findOrCreateTicket({
        emailMessageId: 'email-1',
        classification: classified(),
      }),
    ).rejects.toBeInstanceOf(TicketEngineValidationError);
  });

  it('INVALID_OUTCOME → TicketEngineValidationError', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'INVALID_OUTCOME: classification.outcome must be IN_REVIEW/REJECTED/APPROVED (got PENDING)' },
    });

    await expect(
      findOrCreateTicket({
        emailMessageId: 'email-1',
        classification: classified(),
      }),
    ).rejects.toBeInstanceOf(TicketEngineValidationError);
  });

  it('NOT_FOUND → TicketEngineNotFoundError', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'NOT_FOUND: email_message abc does not exist' },
    });

    await expect(
      findOrCreateTicket({
        emailMessageId: 'email-missing',
        classification: classified(),
      }),
    ).rejects.toBeInstanceOf(TicketEngineNotFoundError);
  });

  it('CONCURRENT_RACE_UNEXPECTED → TicketEngineRaceError', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'CONCURRENT_RACE_UNEXPECTED: find-or-create did not converge in 3 iterations' },
    });

    await expect(
      findOrCreateTicket({
        emailMessageId: 'email-1',
        classification: classified(),
      }),
    ).rejects.toBeInstanceOf(TicketEngineRaceError);
  });

  it('unknown RPC error → generic Error with [ticket-engine] prefix', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'deadlock detected' },
    });

    await expect(
      findOrCreateTicket({
        emailMessageId: 'email-1',
        classification: classified(),
      }),
    ).rejects.toThrow(/\[ticket-engine\] RPC failed: deadlock detected/);
  });

  it('RPC returns null data with no error → throws', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: null });

    await expect(
      findOrCreateTicket({
        emailMessageId: 'email-1',
        classification: classified(),
      }),
    ).rejects.toThrow(/returned no data/);
  });
});

// -- State transition matrix --------------------------------------------
//
// Covers spec §4.1 `deriveStateFromEmailOnOpenTicket` row by row. Each
// test mocks the RPC response that the real `find_or_create_ticket_tx`
// would produce for the (prev_state × email_outcome) combination; the
// engine layer is verified to unwrap the response faithfully.
//
// REJECTED + APPROVED is already covered in the happy-paths suite
// (line 182 "update path, REJECTED → APPROVED"); not duplicated here.

describe('findOrCreateTicket — state transition matrix (spec §4.1)', () => {
  // --- NEW row: triage gate — always NEW regardless of outcome --------
  it('NEW + APPROVED outcome → NEW (triage gate, state_changed=false)', async () => {
    mockRpc.mockResolvedValueOnce(rpcUpdated({ prev: 'NEW', next: 'NEW' }));
    const out = await findOrCreateTicket({
      emailMessageId: 'email-1',
      classification: classifiedWithOutcome('APPROVED'),
    });
    expect(out.previous_state).toBe('NEW');
    expect(out.new_state).toBe('NEW');
    expect(out.state_changed).toBe(false);
  });

  it('NEW + REJECTED outcome → NEW (triage gate, state_changed=false)', async () => {
    mockRpc.mockResolvedValueOnce(rpcUpdated({ prev: 'NEW', next: 'NEW' }));
    const out = await findOrCreateTicket({
      emailMessageId: 'email-1',
      classification: classifiedWithOutcome('REJECTED'),
    });
    expect(out.new_state).toBe('NEW');
    expect(out.state_changed).toBe(false);
  });

  it('NEW + null outcome → NEW (triage gate, state_changed=false)', async () => {
    mockRpc.mockResolvedValueOnce(rpcUpdated({ prev: 'NEW', next: 'NEW' }));
    const out = await findOrCreateTicket({
      emailMessageId: 'email-1',
      classification: classifiedWithOutcome(null),
    });
    expect(out.new_state).toBe('NEW');
    expect(out.state_changed).toBe(false);
  });

  // --- IN_REVIEW row --------------------------------------------------
  it('IN_REVIEW + APPROVED → APPROVED (terminal, closed_at + resolution_type set)', async () => {
    mockRpc.mockResolvedValueOnce(
      rpcUpdated({ prev: 'IN_REVIEW', next: 'APPROVED' }),
    );
    const out = await findOrCreateTicket({
      emailMessageId: 'email-1',
      classification: classifiedWithOutcome('APPROVED'),
    });
    expect(out.previous_state).toBe('IN_REVIEW');
    expect(out.new_state).toBe('APPROVED');
    expect(out.state_changed).toBe(true);
    expect(out.ticket?.closed_at).not.toBeNull();
    expect(out.ticket?.resolution_type).toBe('APPROVED');
  });

  it('IN_REVIEW + REJECTED → REJECTED (state_changed=true)', async () => {
    mockRpc.mockResolvedValueOnce(
      rpcUpdated({ prev: 'IN_REVIEW', next: 'REJECTED' }),
    );
    const out = await findOrCreateTicket({
      emailMessageId: 'email-1',
      classification: classifiedWithOutcome('REJECTED'),
    });
    expect(out.previous_state).toBe('IN_REVIEW');
    expect(out.new_state).toBe('REJECTED');
    expect(out.state_changed).toBe(true);
    // Not terminal — closed_at stays null
    expect(out.ticket?.closed_at).toBeNull();
  });

  it('IN_REVIEW + null outcome → IN_REVIEW (preserve, state_changed=false)', async () => {
    mockRpc.mockResolvedValueOnce(
      rpcUpdated({ prev: 'IN_REVIEW', next: 'IN_REVIEW' }),
    );
    const out = await findOrCreateTicket({
      emailMessageId: 'email-1',
      classification: classifiedWithOutcome(null),
    });
    expect(out.new_state).toBe('IN_REVIEW');
    expect(out.state_changed).toBe(false);
  });

  // --- REJECTED row (REJECTED + APPROVED already covered above) -------
  it('REJECTED + REJECTED → REJECTED (stay, state_changed=false)', async () => {
    mockRpc.mockResolvedValueOnce(
      rpcUpdated({ prev: 'REJECTED', next: 'REJECTED' }),
    );
    const out = await findOrCreateTicket({
      emailMessageId: 'email-1',
      classification: classifiedWithOutcome('REJECTED'),
    });
    expect(out.new_state).toBe('REJECTED');
    expect(out.state_changed).toBe(false);
  });

  it('REJECTED + null outcome → REJECTED (preserve, state_changed=false)', async () => {
    mockRpc.mockResolvedValueOnce(
      rpcUpdated({ prev: 'REJECTED', next: 'REJECTED' }),
    );
    const out = await findOrCreateTicket({
      emailMessageId: 'email-1',
      classification: classifiedWithOutcome(null),
    });
    expect(out.new_state).toBe('REJECTED');
    expect(out.state_changed).toBe(false);
  });

  // --- Resubmit case (spec §4.1 explicit: "REJECTED → email IN_REVIEW → IN_REVIEW") ---
  it('REJECTED + IN_REVIEW → IN_REVIEW (resubmit, state_changed=true)', async () => {
    mockRpc.mockResolvedValueOnce(
      rpcUpdated({ prev: 'REJECTED', next: 'IN_REVIEW' }),
    );
    const out = await findOrCreateTicket({
      emailMessageId: 'email-1',
      classification: classifiedWithOutcome('IN_REVIEW'),
    });
    expect(out.previous_state).toBe('REJECTED');
    expect(out.new_state).toBe('IN_REVIEW');
    expect(out.state_changed).toBe(true);
    expect(out.ticket?.closed_at).toBeNull();
  });
});

// -- Terminal state fall-through (spec §11.2) ---------------------------
//
// Partial unique index excludes APPROVED/DONE/ARCHIVED, so when a new
// email arrives for a (app, type, platform) key whose only ticket is in
// a terminal state, the RPC's FOR UPDATE misses and the CREATE path
// fires. The caller sees `created=true` + state=NEW — identical shape
// to any fresh-key create. These tests pin that indistinguishability
// at the TypeScript layer.

describe('findOrCreateTicket — terminal state fall-through (spec §11.2)', () => {
  it('caller sees created=true when RPC falls through from APPROVED terminal', async () => {
    mockRpc.mockResolvedValueOnce(rpcCreated());
    const out = await findOrCreateTicket({
      emailMessageId: 'email-1',
      classification: classified(),
    });
    expect(out.created).toBe(true);
    expect(out.previous_state).toBeNull();
    expect(out.new_state).toBe('NEW');
    expect(out.state_changed).toBe(false);
  });

  it('caller sees created=true when RPC falls through from DONE terminal', async () => {
    mockRpc.mockResolvedValueOnce(rpcCreated());
    const out = await findOrCreateTicket({
      emailMessageId: 'email-2',
      classification: classified(),
    });
    expect(out.created).toBe(true);
    expect(out.new_state).toBe('NEW');
  });

  it('caller sees created=true when RPC falls through from ARCHIVED terminal', async () => {
    mockRpc.mockResolvedValueOnce(rpcCreated());
    const out = await findOrCreateTicket({
      emailMessageId: 'email-3',
      classification: classified(),
    });
    expect(out.created).toBe(true);
    expect(out.new_state).toBe('NEW');
  });
});

// -- submission_id + type_payload novelty in RPC response ---------------
//
// The RPC appends novel submission_ids / type_payloads internally (spec
// §3.4). These tests verify the engine layer surfaces the resulting
// ticket row faithfully — an anti-regression for the response-mapping
// contract.

describe('findOrCreateTicket — submission_id + type_payload in response', () => {
  it('novel submission_id appended to ticket.submission_ids', async () => {
    mockRpc.mockResolvedValueOnce(
      rpcUpdated({
        prev: 'IN_REVIEW',
        next: 'IN_REVIEW',
        ticketOverrides: { submission_ids: ['sub-123', 'sub-999'] },
      }),
    );
    const out = await findOrCreateTicket({
      emailMessageId: 'email-1',
      classification: classifiedWithOutcome('IN_REVIEW'),
    });
    expect(out.ticket?.submission_ids).toEqual(['sub-123', 'sub-999']);
  });

  it('existing submission_id → array unchanged (RPC dedup)', async () => {
    mockRpc.mockResolvedValueOnce(
      rpcUpdated({
        prev: 'IN_REVIEW',
        next: 'IN_REVIEW',
        ticketOverrides: { submission_ids: ['sub-123'] },
      }),
    );
    const out = await findOrCreateTicket({
      emailMessageId: 'email-1',
      classification: classifiedWithOutcome('IN_REVIEW'),
    });
    expect(out.ticket?.submission_ids).toEqual(['sub-123']);
  });

  it('empty type_payload {} → ticket.type_payloads unchanged (RPC skip per §3.3 deviation)', async () => {
    // RPC normalizes `{}` to NULL at extraction (migration line 196-199).
    // type_payloads stays `[]`; no PAYLOAD_ADDED signal. Engine just
    // passes the unchanged array through.
    mockRpc.mockResolvedValueOnce(
      rpcUpdated({
        prev: 'IN_REVIEW',
        next: 'IN_REVIEW',
        ticketOverrides: { type_payloads: [] },
      }),
    );
    const out = await findOrCreateTicket({
      emailMessageId: 'email-1',
      classification: classifiedWithOutcome('IN_REVIEW'),
    });
    expect(out.ticket?.type_payloads).toEqual([]);
  });

  it('non-empty type_payload appended to ticket.type_payloads', async () => {
    mockRpc.mockResolvedValueOnce(
      rpcUpdated({
        prev: 'IN_REVIEW',
        next: 'IN_REVIEW',
        ticketOverrides: {
          type_payloads: [
            {
              payload: { version: '2.4.1', os: 'iOS' },
              first_seen_at: '2026-04-23T00:00:00Z',
            },
          ],
        },
      }),
    );
    const out = await findOrCreateTicket({
      emailMessageId: 'email-1',
      classification: {
        ...classified(),
        type_payload: { version: '2.4.1', os: 'iOS' },
      },
    });
    expect(out.ticket?.type_payloads).toHaveLength(1);
  });
});

// -- EMAIL entry idempotency (partial unique index) --------------------
//
// Same `email_message_id` processed twice → RPC's ON CONFLICT DO NOTHING
// (migration line 405) swallows the second EMAIL entry. The ticket row
// is idempotent too: second call returns the same ticket_id.
// Engine-layer test verifies caller sees consistent ticketId across
// duplicate invocations.

describe('findOrCreateTicket — EMAIL idempotency (spec §3.3 + partial index)', () => {
  it('same email_message_id twice → same ticketId, engine reflects RPC dedup', async () => {
    // First call: CREATE path — fresh ticket.
    mockRpc.mockResolvedValueOnce(rpcCreated());

    // Second call: same email → RPC finds the now-existing open ticket,
    // UPDATE path runs but ON CONFLICT DO NOTHING skips the duplicate
    // EMAIL entry. state stays NEW (create path left it NEW, UPDATE
    // path preserves NEW per triage gate).
    mockRpc.mockResolvedValueOnce(
      rpcUpdated({ prev: 'NEW', next: 'NEW' }),
    );

    const first = await findOrCreateTicket({
      emailMessageId: 'email-dup',
      classification: classified(),
    });
    const second = await findOrCreateTicket({
      emailMessageId: 'email-dup',
      classification: classified(),
    });

    expect(first.ticketId).toBe('ticket-abc');
    expect(second.ticketId).toBe('ticket-abc');
    expect(first.ticketId).toBe(second.ticketId);
    expect(second.created).toBe(false); // second call is update path
  });
});
