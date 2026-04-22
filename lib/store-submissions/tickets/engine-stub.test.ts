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
} from './engine-stub';

const { mockRandomUUID } = vi.hoisted(() => ({
  mockRandomUUID: vi.fn(),
}));

vi.mock('node:crypto', () => ({
  randomUUID: mockRandomUUID,
}));

beforeEach(() => {
  mockRandomUUID.mockReturnValue('stub-ticket-uuid');
});

afterEach(() => {
  vi.resetAllMocks();
});

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

describe('findOrCreateTicket (stub)', () => {
  it('returns ephemeral UUID for CLASSIFIED', async () => {
    const out = await findOrCreateTicket({
      emailMessageId: 'email-1',
      classification: classified(),
    });
    expect(out).toEqual({
      ticketId: 'stub-ticket-uuid',
      created: true,
      new_state: 'NEW',
    });
    expect(mockRandomUUID).toHaveBeenCalledTimes(1);
  });

  it('returns ticket for UNCLASSIFIED_APP (bucket ticket)', async () => {
    const out = await findOrCreateTicket({
      emailMessageId: 'email-2',
      classification: unclassifiedApp(),
    });
    expect(out.ticketId).toBe('stub-ticket-uuid');
    expect(out.created).toBe(true);
    expect(out.new_state).toBe('NEW');
  });

  it('returns ticket for UNCLASSIFIED_TYPE (bucket ticket)', async () => {
    const out = await findOrCreateTicket({
      emailMessageId: 'email-3',
      classification: unclassifiedType(),
    });
    expect(out.ticketId).toBe('stub-ticket-uuid');
    expect(out.created).toBe(true);
    expect(out.new_state).toBe('NEW');
  });

  it('throws TicketEngineNotApplicableError for DROPPED', async () => {
    const dropped: DroppedResult = {
      status: 'DROPPED',
      reason: 'NO_SENDER_MATCH',
    };
    await expect(
      findOrCreateTicket({
        emailMessageId: 'email-4',
        // Caller contract violation; simulate a wire bug bypassing the gate.
        classification: dropped as unknown as UnclassifiedAppResult,
      }),
    ).rejects.toBeInstanceOf(TicketEngineNotApplicableError);
  });

  it('throws TicketEngineNotApplicableError for ERROR', async () => {
    const error: ErrorResult = {
      status: 'ERROR',
      error_code: 'PARSE_ERROR',
      error_message: 'boom',
      matched_rules: [],
    };
    await expect(
      findOrCreateTicket({
        emailMessageId: 'email-5',
        classification: error as unknown as UnclassifiedAppResult,
      }),
    ).rejects.toBeInstanceOf(TicketEngineNotApplicableError);
  });

  it('is non-deterministic across calls (ephemeral UUID, no dedup)', async () => {
    mockRandomUUID
      .mockReturnValueOnce('uuid-first')
      .mockReturnValueOnce('uuid-second');

    const a = await findOrCreateTicket({
      emailMessageId: 'email-a',
      classification: classified(),
    });
    const b = await findOrCreateTicket({
      emailMessageId: 'email-b',
      classification: classified(),
    });

    expect(a.ticketId).toBe('uuid-first');
    expect(b.ticketId).toBe('uuid-second');
    expect(a.ticketId).not.toBe(b.ticketId);
  });
});
