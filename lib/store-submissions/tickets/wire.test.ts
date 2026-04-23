import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ClassifiedResult,
  DroppedResult,
  ErrorResult,
  UnclassifiedAppResult,
  UnclassifiedTypeResult,
} from '../classifier/types';

import { associateEmailWithTicket } from './wire';

const { mockUpdate, mockUpdateEq, mockFrom, mockFindOrCreateTicket } =
  vi.hoisted(() => ({
    mockUpdate: vi.fn(),
    mockUpdateEq: vi.fn(),
    mockFrom: vi.fn(),
    mockFindOrCreateTicket: vi.fn(),
  }));

vi.mock('../db', () => ({
  storeDb: () => ({ from: mockFrom }),
}));

vi.mock('./engine', () => ({
  findOrCreateTicket: mockFindOrCreateTicket,
}));

beforeEach(() => {
  mockFrom.mockReturnValue({ update: mockUpdate });
  mockUpdate.mockReturnValue({ eq: mockUpdateEq });
  mockUpdateEq.mockResolvedValue({ error: null });
  // Default mock mirrors the PR-9 real engine's full output shape
  // (previous_state / state_changed / ticket populated). Wire should
  // read only `ticketId`; the extended fields are regression-tested
  // separately below.
  mockFindOrCreateTicket.mockResolvedValue({
    ticketId: 'ticket-abc',
    created: true,
    new_state: 'NEW',
    previous_state: null,
    state_changed: false,
    ticket: {
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
    },
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.resetAllMocks();
});

const classified: ClassifiedResult = {
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

const unclassifiedApp: UnclassifiedAppResult = {
  status: 'UNCLASSIFIED_APP',
  platform_id: 'platform-apple',
  outcome: 'APPROVED',
  extracted_app_name: null,
  matched_rules: [],
};

const unclassifiedType: UnclassifiedTypeResult = {
  status: 'UNCLASSIFIED_TYPE',
  platform_id: 'platform-apple',
  app_id: 'app-tft',
  outcome: 'APPROVED',
  extracted_app_name: 'TFT',
  matched_rules: [],
};

const dropped: DroppedResult = {
  status: 'DROPPED',
  reason: 'NO_SENDER_MATCH',
};

const errorResult: ErrorResult = {
  status: 'ERROR',
  error_code: 'PARSE_ERROR',
  error_message: 'boom',
  matched_rules: [],
};

describe('associateEmailWithTicket — gate', () => {
  it('returns null for DROPPED without calling engine', async () => {
    const out = await associateEmailWithTicket('email-1', dropped);
    expect(out).toBeNull();
    expect(mockFindOrCreateTicket).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns null for ERROR without calling engine', async () => {
    const out = await associateEmailWithTicket('email-1', errorResult);
    expect(out).toBeNull();
    expect(mockFindOrCreateTicket).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('associateEmailWithTicket — happy path', () => {
  it('CLASSIFIED → engine called + email_messages UPDATE + returns ticketId', async () => {
    const out = await associateEmailWithTicket('email-1', classified);

    expect(mockFindOrCreateTicket).toHaveBeenCalledWith({
      emailMessageId: 'email-1',
      classification: classified,
    });
    expect(mockFrom).toHaveBeenCalledWith('email_messages');
    expect(mockUpdate).toHaveBeenCalledWith({ ticket_id: 'ticket-abc' });
    expect(mockUpdateEq).toHaveBeenCalledWith('id', 'email-1');
    expect(out).toEqual({ ticketId: 'ticket-abc' });
  });

  it('UNCLASSIFIED_APP → engine called (bucket ticket)', async () => {
    const out = await associateEmailWithTicket('email-2', unclassifiedApp);
    expect(mockFindOrCreateTicket).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ ticketId: 'ticket-abc' });
  });

  it('UNCLASSIFIED_TYPE → engine called (bucket ticket)', async () => {
    const out = await associateEmailWithTicket('email-3', unclassifiedType);
    expect(mockFindOrCreateTicket).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ ticketId: 'ticket-abc' });
  });
});

describe('associateEmailWithTicket — graceful failure', () => {
  it('engine throws → logs ERROR, returns null, does NOT UPDATE', async () => {
    mockFindOrCreateTicket.mockRejectedValueOnce(new Error('engine boom'));

    const out = await associateEmailWithTicket('email-1', classified);

    expect(out).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[tickets-wire]'),
      expect.objectContaining({
        emailMessageId: 'email-1',
        status: 'CLASSIFIED',
      }),
    );
  });

  it('UPDATE fails → logs ERROR, returns null (link lost but engine ran)', async () => {
    mockUpdateEq.mockResolvedValueOnce({
      error: { message: 'deadlock detected' },
    });

    const out = await associateEmailWithTicket('email-1', classified);

    expect(out).toBeNull();
    expect(mockFindOrCreateTicket).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[tickets-wire]'),
      expect.objectContaining({
        emailMessageId: 'email-1',
        ticketId: 'ticket-abc',
      }),
    );
  });

  it('never rethrows — sync batch must continue', async () => {
    mockFindOrCreateTicket.mockRejectedValueOnce(new Error('catastrophic'));

    await expect(
      associateEmailWithTicket('email-1', classified),
    ).resolves.toBeNull();
  });

  it('engine-typed errors (e.g. TicketEngineValidationError) → same graceful path', async () => {
    // Regression guard: wire's try/catch is intentionally error-agnostic.
    // If someone later adds error-specific branching (e.g. rethrow on
    // TicketEngineRaceError), this test pins the current contract:
    // ALL engine errors collapse to null + [tickets-wire] log.
    class TicketEngineValidationError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'TicketEngineValidationError';
      }
    }
    mockFindOrCreateTicket.mockRejectedValueOnce(
      new TicketEngineValidationError(
        '[ticket-engine] validation: INVALID_OUTCOME',
      ),
    );

    const out = await associateEmailWithTicket('email-1', classified);

    expect(out).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[tickets-wire]'),
      expect.objectContaining({
        emailMessageId: 'email-1',
        status: 'CLASSIFIED',
        error: expect.objectContaining({
          name: 'TicketEngineValidationError',
        }),
      }),
    );
  });
});

describe('associateEmailWithTicket — extended engine output', () => {
  it('ignores extended fields (ticket / previous_state / state_changed) — reads only ticketId', async () => {
    // Regression guard: wire must not accidentally grow dependencies on
    // PR-9 extended fields. If wire ever starts reading `ticket.state`
    // etc., this test breaks and forces an interface review.
    mockFindOrCreateTicket.mockResolvedValueOnce({
      ticketId: 'ticket-xyz',
      created: false,
      new_state: 'APPROVED',
      previous_state: 'REJECTED',
      state_changed: true,
      ticket: {
        id: 'ticket-xyz',
        // Intentionally minimal / malformed remaining fields — wire
        // should not touch them at all.
      } as never,
    });

    const out = await associateEmailWithTicket('email-1', classified);

    expect(out).toEqual({ ticketId: 'ticket-xyz' });
    expect(mockUpdate).toHaveBeenCalledWith({ ticket_id: 'ticket-xyz' });
  });
});
