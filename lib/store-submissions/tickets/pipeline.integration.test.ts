/**
 * Pipeline integration tests — wire ↔ engine ↔ RPC.
 *
 * Strategy (Option C hybrid): exercise REAL `wire.ts` + REAL `engine.ts`,
 * mocking only the outer Supabase boundary (`storeDb`). Other integration
 * tests split the mocking line elsewhere:
 *
 *   - `wire.test.ts`    mocks `./engine` (wire-only unit coverage).
 *   - `engine.test.ts`  mocks `storeDb().rpc` (engine-only unit coverage).
 *   - `gmail/sync.test.ts` mocks `../tickets/wire` (sync orchestration
 *                          coverage).
 *
 * This file closes the gap: verifies that when something upstream calls
 * `associateEmailWithTicket`, the classification JSONB + email id flow
 * through wire → engine → RPC with the correct shape, and the RPC's
 * return payload flows back through engine → wire → caller with the
 * correct shape.
 *
 * SQL correctness of the RPC itself is validated via migration review
 * + post-deploy verification (see migration header comments). Real
 * Supabase local is out of scope for PR-9.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ClassifiedResult,
  DroppedResult,
  ErrorResult,
  UnclassifiedAppResult,
  UnclassifiedTypeResult,
} from '../classifier/types';

import type { TicketRow } from './types';
import { associateEmailWithTicket } from './wire';

// -- Mocks ---------------------------------------------------------------

const { mockRpc, mockFrom, mockUpdate, mockUpdateEq } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockFrom: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateEq: vi.fn(),
}));

vi.mock('../db', () => ({
  storeDb: () => ({
    from: mockFrom,
    rpc: mockRpc,
  }),
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

function rpcCreated(overrides: Partial<TicketRow> = {}) {
  return {
    data: {
      ticket_id: 'ticket-abc',
      created: true,
      previous_state: null,
      new_state: 'NEW',
      state_changed: false,
      ticket: baseTicket(overrides),
    },
    error: null,
  };
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
  vi.resetAllMocks();
  // Supabase `.from().update().eq()` chain — terminal returns { error }.
  mockFrom.mockReturnValue({ update: mockUpdate });
  mockUpdate.mockReturnValue({ eq: mockUpdateEq });
  mockUpdateEq.mockResolvedValue({ error: null });
  // Silence expected [tickets-wire] error logs during graceful-path tests.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.resetAllMocks();
});

// -- Forward flow (classification → ticketId) ---------------------------

describe('pipeline — classification flows through wire→engine→RPC', () => {
  it('CLASSIFIED: RPC receives full classification JSONB + email id; wire UPDATEs ticket_id', async () => {
    mockRpc.mockResolvedValueOnce(rpcCreated());
    const c = classified();

    const out = await associateEmailWithTicket('email-1', c);

    // Engine invoked RPC with the exact classification + email id shape
    // the RPC's (p_classification JSONB, p_email_message_id UUID)
    // signature expects.
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('find_or_create_ticket_tx', {
      p_classification: c,
      p_email_message_id: 'email-1',
    });

    // Wire back-filled email_messages.ticket_id with the RPC's returned id.
    expect(mockFrom).toHaveBeenCalledWith('email_messages');
    expect(mockUpdate).toHaveBeenCalledWith({ ticket_id: 'ticket-abc' });
    expect(mockUpdateEq).toHaveBeenCalledWith('id', 'email-1');
    expect(out).toEqual({ ticketId: 'ticket-abc' });
  });

  it('UNCLASSIFIED_APP: app_id absent from classification, RPC still invoked', async () => {
    mockRpc.mockResolvedValueOnce(
      rpcCreated({ app_id: null, type_id: null }),
    );
    const c = unclassifiedApp();

    const out = await associateEmailWithTicket('email-2', c);

    expect(mockRpc).toHaveBeenCalledTimes(1);
    const rpcCall = mockRpc.mock.calls[0]![1] as Record<string, unknown>;
    expect(rpcCall.p_email_message_id).toBe('email-2');
    const passedClass = rpcCall.p_classification as Record<string, unknown>;
    expect(passedClass.status).toBe('UNCLASSIFIED_APP');
    expect(passedClass.app_id).toBeUndefined();
    expect(out).toEqual({ ticketId: 'ticket-abc' });
  });

  it('UNCLASSIFIED_TYPE: app_id present, type_id absent; RPC invoked', async () => {
    mockRpc.mockResolvedValueOnce(rpcCreated({ type_id: null }));
    const c = unclassifiedType();

    const out = await associateEmailWithTicket('email-3', c);

    expect(mockRpc).toHaveBeenCalledTimes(1);
    const passedClass = mockRpc.mock.calls[0]![1]!
      .p_classification as Record<string, unknown>;
    expect(passedClass.status).toBe('UNCLASSIFIED_TYPE');
    expect(passedClass.app_id).toBe('app-tft');
    expect(passedClass.type_id).toBeUndefined();
    expect(out).toEqual({ ticketId: 'ticket-abc' });
  });
});

// -- Non-ticketable gate (RPC never invoked) ----------------------------

describe('pipeline — non-ticketable classifications short-circuit', () => {
  it('DROPPED: wire gate fires, engine never invoked, no RPC call', async () => {
    const dropped: DroppedResult = {
      status: 'DROPPED',
      reason: 'NO_SENDER_MATCH',
    };

    const out = await associateEmailWithTicket('email-1', dropped);

    expect(out).toBeNull();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('ERROR: wire gate fires, engine never invoked, no RPC call', async () => {
    const err: ErrorResult = {
      status: 'ERROR',
      error_code: 'PARSE_ERROR',
      error_message: 'boom',
      matched_rules: [],
    };

    const out = await associateEmailWithTicket('email-1', err);

    expect(out).toBeNull();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

// -- RPC error propagation → wire graceful-null ------------------------

describe('pipeline — RPC errors collapse to wire-null', () => {
  it('INVALID_ARG (classification shape) → wire catches, returns null, no UPDATE', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'INVALID_ARG: classification.platform_id required' },
    });

    const out = await associateEmailWithTicket('email-1', classified());

    expect(out).toBeNull();
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[tickets-wire]'),
      expect.objectContaining({
        emailMessageId: 'email-1',
        error: expect.objectContaining({
          name: 'TicketEngineValidationError',
        }),
      }),
    );
  });

  it('CONCURRENT_RACE_UNEXPECTED → wire catches TicketEngineRaceError, returns null', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: {
        message:
          'CONCURRENT_RACE_UNEXPECTED: find-or-create did not converge in 3 iterations',
      },
    });

    const out = await associateEmailWithTicket('email-1', classified());

    expect(out).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[tickets-wire]'),
      expect.objectContaining({
        error: expect.objectContaining({
          name: 'TicketEngineRaceError',
        }),
      }),
    );
  });

  it('NOT_FOUND (email row deleted mid-flight) → wire catches, returns null', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'NOT_FOUND: email_message ghost does not exist' },
    });

    const out = await associateEmailWithTicket('email-missing', classified());

    expect(out).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[tickets-wire]'),
      expect.objectContaining({
        error: expect.objectContaining({
          name: 'TicketEngineNotFoundError',
        }),
      }),
    );
  });

  it('UPDATE failure after successful RPC → ticket exists but link lost, returns null', async () => {
    mockRpc.mockResolvedValueOnce(rpcCreated());
    mockUpdateEq.mockResolvedValueOnce({
      error: { message: 'deadlock detected' },
    });

    const out = await associateEmailWithTicket('email-1', classified());

    expect(out).toBeNull();
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[tickets-wire]'),
      expect.objectContaining({
        emailMessageId: 'email-1',
        ticketId: 'ticket-abc',
      }),
    );
  });
});

// -- Extended return-shape propagation ---------------------------------

describe('pipeline — RPC extended fields flow through engine unwrap', () => {
  it('state transition (REJECTED→APPROVED): engine unwraps RPC shape; wire still returns only ticketId', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        ticket_id: 'ticket-xyz',
        created: false,
        previous_state: 'REJECTED',
        new_state: 'APPROVED',
        state_changed: true,
        ticket: baseTicket({
          id: 'ticket-xyz',
          state: 'APPROVED',
          closed_at: '2026-04-23T00:00:00Z',
          resolution_type: 'APPROVED',
        }),
      },
      error: null,
    });

    const out = await associateEmailWithTicket('email-1', classified());

    // Wire-level output unchanged — extended fields (`ticket`,
    // `previous_state`, `state_changed`) exist inside the engine call
    // path but wire returns only `{ ticketId }`.
    expect(out).toEqual({ ticketId: 'ticket-xyz' });
    expect(mockUpdate).toHaveBeenCalledWith({ ticket_id: 'ticket-xyz' });
  });
});

// -- Multi-email batch (idempotency + sequential state) -----------------

describe('pipeline — multi-email batch through real engine', () => {
  it('5-email batch: 2 CLASSIFIED + 1 UNCLASSIFIED_APP + 1 DROPPED + 1 ERROR → 3 RPC calls, 2 gated', async () => {
    mockRpc
      .mockResolvedValueOnce(rpcCreated({ id: 't-1' }))
      .mockResolvedValueOnce(rpcCreated({ id: 't-2' }))
      .mockResolvedValueOnce(rpcCreated({ id: 't-3', app_id: null, type_id: null }));

    const results = await Promise.all([
      associateEmailWithTicket('em-1', classified()),
      associateEmailWithTicket('em-2', classified()),
      associateEmailWithTicket('em-3', unclassifiedApp()),
      associateEmailWithTicket('em-4', {
        status: 'DROPPED',
        reason: 'NO_SENDER_MATCH',
      } as DroppedResult),
      associateEmailWithTicket('em-5', {
        status: 'ERROR',
        error_code: 'PARSE_ERROR',
        error_message: 'x',
        matched_rules: [],
      } as ErrorResult),
    ]);

    expect(mockRpc).toHaveBeenCalledTimes(3);
    expect(results[0]).toEqual({ ticketId: 'ticket-abc' });
    expect(results[1]).toEqual({ ticketId: 'ticket-abc' });
    expect(results[2]).toEqual({ ticketId: 'ticket-abc' });
    expect(results[3]).toBeNull(); // DROPPED
    expect(results[4]).toBeNull(); // ERROR
  });

  it('idempotency: same email_message_id twice → RPC invoked twice, same ticketId both calls', async () => {
    // RPC is idempotent by contract (partial unique index on ticket_entries).
    // Both calls return the same ticket_id; wire back-fills identically.
    mockRpc.mockResolvedValue(rpcCreated());

    const first = await associateEmailWithTicket('email-dup', classified());
    const second = await associateEmailWithTicket('email-dup', classified());

    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(first).toEqual({ ticketId: 'ticket-abc' });
    expect(second).toEqual({ ticketId: 'ticket-abc' });
  });

  it('state progression: email 1 creates NEW, email 2 updates same key IN_REVIEW→APPROVED', async () => {
    // Email 1 → CREATE path (RPC returns created=true, state=NEW)
    mockRpc.mockResolvedValueOnce(rpcCreated());
    // Email 2 → UPDATE path (RPC returns created=false, IN_REVIEW→APPROVED)
    mockRpc.mockResolvedValueOnce({
      data: {
        ticket_id: 'ticket-abc',
        created: false,
        previous_state: 'IN_REVIEW',
        new_state: 'APPROVED',
        state_changed: true,
        ticket: baseTicket({
          state: 'APPROVED',
          closed_at: '2026-04-23T01:00:00Z',
          resolution_type: 'APPROVED',
        }),
      },
      error: null,
    });

    const r1 = await associateEmailWithTicket('email-1', classified());
    const r2 = await associateEmailWithTicket('email-2', classified());

    expect(r1).toEqual({ ticketId: 'ticket-abc' });
    expect(r2).toEqual({ ticketId: 'ticket-abc' });
    // Same ticketId across the progression — grouping key invariant holds.
    expect(r1?.ticketId).toBe(r2?.ticketId);
    // Both RPC calls carried the same classification shape.
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });
});
