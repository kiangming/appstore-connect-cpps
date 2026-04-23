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
}) {
  return {
    data: {
      ticket_id: 'ticket-abc',
      created: false,
      previous_state: opts.prev,
      new_state: opts.next,
      state_changed: opts.prev !== opts.next,
      ticket: baseTicket({ state: opts.next }),
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
