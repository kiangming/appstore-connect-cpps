import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UnauthorizedActionError } from './auth';
import {
  CommentOwnershipError,
  ConcurrentModificationError,
  executeUserAction,
  InvalidTransitionRpcError,
  TicketNotFoundError,
  UserActionValidationError,
} from './user-actions';

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));

vi.mock('../db', () => ({
  storeDb: () => ({ rpc: mockRpc }),
}));

const DEV = { id: 'user-dev', role: 'DEV' as const };
const VIEWER = { id: 'user-viewer', role: 'VIEWER' as const };

beforeEach(() => {
  mockRpc.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function rpcOk(
  overrides: Partial<{
    ticket_id: string;
    previous_state: string;
    new_state: string;
    state_changed: boolean;
    entry_id: string;
  }> = {},
) {
  return {
    data: {
      ticket_id: 'ticket-1',
      previous_state: 'NEW',
      new_state: 'ARCHIVED',
      state_changed: true,
      entry_id: 'entry-1',
      ...overrides,
    },
    error: null,
  };
}

function rpcErr(message: string) {
  return {
    data: null,
    error: { message, code: '', details: '', hint: '' },
  };
}

// -- Auth gate (runs before RPC) ------------------------------------------

describe('executeUserAction — auth gate', () => {
  it('VIEWER + ARCHIVE throws UnauthorizedActionError without issuing RPC', async () => {
    await expect(
      executeUserAction({
        ticketId: 'ticket-1',
        actor: VIEWER,
        request: { type: 'ARCHIVE' },
      }),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('VIEWER + ADD_COMMENT throws without issuing RPC', async () => {
    await expect(
      executeUserAction({
        ticketId: 'ticket-1',
        actor: VIEWER,
        request: { type: 'ADD_COMMENT', content: 'hi' },
      }),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// -- Dispatch routing ------------------------------------------------------

describe('executeUserAction — RPC dispatch routing', () => {
  it('ARCHIVE → archive_ticket_tx with ticket+actor', async () => {
    mockRpc.mockResolvedValue(rpcOk());
    await executeUserAction({
      ticketId: 'ticket-1',
      actor: DEV,
      request: { type: 'ARCHIVE' },
    });
    expect(mockRpc).toHaveBeenCalledWith('archive_ticket_tx', {
      p_ticket_id: 'ticket-1',
      p_actor_user_id: 'user-dev',
    });
  });

  it('FOLLOW_UP → follow_up_ticket_tx', async () => {
    mockRpc.mockResolvedValue(rpcOk({ new_state: 'IN_REVIEW' }));
    await executeUserAction({
      ticketId: 'ticket-1',
      actor: DEV,
      request: { type: 'FOLLOW_UP' },
    });
    expect(mockRpc).toHaveBeenCalledWith('follow_up_ticket_tx', expect.any(Object));
  });

  it('ADD_COMMENT → add_comment_tx with content', async () => {
    mockRpc.mockResolvedValue(
      rpcOk({
        previous_state: 'IN_REVIEW',
        new_state: 'IN_REVIEW',
        state_changed: false,
      }),
    );
    await executeUserAction({
      ticketId: 'ticket-1',
      actor: DEV,
      request: { type: 'ADD_COMMENT', content: 'this looks fine' },
    });
    expect(mockRpc).toHaveBeenCalledWith('add_comment_tx', {
      p_ticket_id: 'ticket-1',
      p_actor_user_id: 'user-dev',
      p_content: 'this looks fine',
    });
  });

  it('EDIT_COMMENT → edit_comment_tx passes both ticketId and entryId', async () => {
    // ticket_id cross-check: prevents URL-manipulated edits on entries
    // belonging to a different ticket. Per user-actions.ts header note.
    mockRpc.mockResolvedValue(
      rpcOk({
        previous_state: 'IN_REVIEW',
        new_state: 'IN_REVIEW',
        state_changed: false,
        entry_id: 'entry-42',
      }),
    );
    await executeUserAction({
      ticketId: 'ticket-1',
      actor: DEV,
      request: {
        type: 'EDIT_COMMENT',
        entryId: 'entry-42',
        content: 'updated',
      },
    });
    expect(mockRpc).toHaveBeenCalledWith('edit_comment_tx', {
      p_ticket_id: 'ticket-1',
      p_entry_id: 'entry-42',
      p_actor_user_id: 'user-dev',
      p_content: 'updated',
    });
  });

  it('ADD_REJECT_REASON → add_reject_reason_tx', async () => {
    mockRpc.mockResolvedValue(
      rpcOk({
        previous_state: 'REJECTED',
        new_state: 'REJECTED',
        state_changed: false,
      }),
    );
    await executeUserAction({
      ticketId: 'ticket-1',
      actor: DEV,
      request: {
        type: 'ADD_REJECT_REASON',
        content: 'Metadata issue — 2.3.10',
      },
    });
    expect(mockRpc).toHaveBeenCalledWith('add_reject_reason_tx', {
      p_ticket_id: 'ticket-1',
      p_actor_user_id: 'user-dev',
      p_content: 'Metadata issue — 2.3.10',
    });
  });
});

// -- Happy-path return-shape -----------------------------------------------

describe('executeUserAction — return shape', () => {
  it('maps snake_case RPC result → camelCase output', async () => {
    mockRpc.mockResolvedValue(
      rpcOk({
        ticket_id: 'ticket-99',
        previous_state: 'NEW',
        new_state: 'ARCHIVED',
        state_changed: true,
        entry_id: 'entry-7',
      }),
    );
    const result = await executeUserAction({
      ticketId: 'ticket-99',
      actor: DEV,
      request: { type: 'ARCHIVE' },
    });
    expect(result).toEqual({
      ticketId: 'ticket-99',
      previousState: 'NEW',
      newState: 'ARCHIVED',
      stateChanged: true,
      entryId: 'entry-7',
    });
  });
});

// -- Error mapping ---------------------------------------------------------

describe('executeUserAction — RPC error mapping', () => {
  it('INVALID_TRANSITION → InvalidTransitionRpcError', async () => {
    mockRpc.mockResolvedValue(
      rpcErr('INVALID_TRANSITION: cannot archive ticket in state IN_REVIEW'),
    );
    await expect(
      executeUserAction({
        ticketId: 'ticket-1',
        actor: DEV,
        request: { type: 'ARCHIVE' },
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionRpcError);
  });

  it('NOT_FOUND → TicketNotFoundError', async () => {
    mockRpc.mockResolvedValue(rpcErr('NOT_FOUND: ticket xyz does not exist'));
    await expect(
      executeUserAction({
        ticketId: 'ticket-xyz',
        actor: DEV,
        request: { type: 'ARCHIVE' },
      }),
    ).rejects.toBeInstanceOf(TicketNotFoundError);
  });

  it('COMMENT_FORBIDDEN → CommentOwnershipError', async () => {
    mockRpc.mockResolvedValue(
      rpcErr('COMMENT_FORBIDDEN: actor is not the comment author'),
    );
    await expect(
      executeUserAction({
        ticketId: 'ticket-1',
        actor: DEV,
        request: { type: 'EDIT_COMMENT', entryId: 'entry-1', content: 'x' },
      }),
    ).rejects.toBeInstanceOf(CommentOwnershipError);
  });

  it('INVALID_ARG → UserActionValidationError', async () => {
    mockRpc.mockResolvedValue(rpcErr('INVALID_ARG: content must be non-empty'));
    await expect(
      executeUserAction({
        ticketId: 'ticket-1',
        actor: DEV,
        request: { type: 'ADD_COMMENT', content: '' },
      }),
    ).rejects.toBeInstanceOf(UserActionValidationError);
  });

  it('CONCURRENT_RACE_UNEXPECTED → ConcurrentModificationError', async () => {
    mockRpc.mockResolvedValue(
      rpcErr('CONCURRENT_RACE_UNEXPECTED: lock timeout after 3 retries'),
    );
    await expect(
      executeUserAction({
        ticketId: 'ticket-1',
        actor: DEV,
        request: { type: 'ARCHIVE' },
      }),
    ).rejects.toBeInstanceOf(ConcurrentModificationError);
  });

  it('unknown RPC error → generic Error', async () => {
    mockRpc.mockResolvedValue(rpcErr('some-unexpected-postgres-error'));
    const p = executeUserAction({
      ticketId: 'ticket-1',
      actor: DEV,
      request: { type: 'ARCHIVE' },
    });
    await expect(p).rejects.toThrow(/RPC failed/);
    await expect(p).rejects.not.toBeInstanceOf(InvalidTransitionRpcError);
    await expect(p).rejects.not.toBeInstanceOf(TicketNotFoundError);
  });

  it('RPC returns null data without error → throws generic Error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await expect(
      executeUserAction({
        ticketId: 'ticket-1',
        actor: DEV,
        request: { type: 'ARCHIVE' },
      }),
    ).rejects.toThrow(/returned no data/);
  });
});
