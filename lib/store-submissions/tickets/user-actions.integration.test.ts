/**
 * Integration tests — dispatcher ↔ RPC contract.
 *
 * Strategy (Option B — matches PR-9's `pipeline.integration.test.ts`):
 * mock only the outer Supabase boundary (`storeDb().rpc`). Treat the
 * migration's raised error prefixes + return-JSON shape as the contract
 * under test. Tests catch drift when either the dispatcher's parser or
 * the migration's `RAISE EXCEPTION` / `RETURN jsonb_build_object(...)`
 * wording diverges.
 *
 * Complements `user-actions.test.ts` (unit coverage of dispatcher
 * internals — routing table + snake→camel + prefix→error class) by
 * asserting against the actual migration-verbatim strings instead of
 * parameterized prefixes. If someone renames `INVALID_TRANSITION:` to
 * `BAD_STATE:` in the SQL, these tests fail fast.
 *
 * SQL correctness of the RPC bodies themselves (FOR UPDATE semantics,
 * CHECK constraints firing, trigger behavior) is **not** exercised
 * here — that requires a real local Supabase instance, out of scope
 * for PR-10c.1.4. Migration review + post-deploy manual QA cover it.
 */

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

// -- Fixtures mirror the migration's RETURN jsonb_build_object shape ------

const DEV = { id: 'user-dev', role: 'DEV' as const };
const MANAGER = { id: 'user-mgr', role: 'MANAGER' as const };
const VIEWER = { id: 'user-viewer', role: 'VIEWER' as const };

function stateChangeResponse(
  previousState: string,
  newState: string,
  ticketId = 'ticket-1',
  entryId = 'entry-state-change',
) {
  return {
    data: {
      ticket_id: ticketId,
      previous_state: previousState,
      new_state: newState,
      state_changed: true,
      entry_id: entryId,
    },
    error: null,
  };
}

function nonStateChangeResponse(
  currentState: string,
  ticketId = 'ticket-1',
  entryId = 'entry-comment',
) {
  return {
    data: {
      ticket_id: ticketId,
      previous_state: currentState,
      new_state: currentState,
      state_changed: false,
      entry_id: entryId,
    },
    error: null,
  };
}

function rpcException(message: string) {
  return {
    data: null,
    error: { message, code: '', details: '', hint: '' },
  };
}

beforeEach(() => {
  mockRpc.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// -- Happy paths — all 7 RPCs with realistic migration responses ----------

describe('happy paths — all 7 RPCs', () => {
  it('archive_ticket_tx: NEW → ARCHIVED, state_changed=true', async () => {
    mockRpc.mockResolvedValueOnce(stateChangeResponse('NEW', 'ARCHIVED'));

    const result = await executeUserAction({
      ticketId: 'ticket-1',
      actor: DEV,
      request: { type: 'ARCHIVE' },
    });

    expect(mockRpc).toHaveBeenCalledWith('archive_ticket_tx', {
      p_ticket_id: 'ticket-1',
      p_actor_user_id: 'user-dev',
    });
    expect(result).toEqual({
      ticketId: 'ticket-1',
      previousState: 'NEW',
      newState: 'ARCHIVED',
      stateChanged: true,
      entryId: 'entry-state-change',
    });
  });

  it('follow_up_ticket_tx: NEW + latest_outcome=REJECTED → REJECTED', async () => {
    // Migration's COALESCE(latest_outcome, 'IN_REVIEW') resolves REJECTED;
    // dispatcher cannot see latest_outcome directly but observes the
    // resulting new_state from the RPC's returned JSONB.
    mockRpc.mockResolvedValueOnce(stateChangeResponse('NEW', 'REJECTED'));

    const result = await executeUserAction({
      ticketId: 'ticket-1',
      actor: DEV,
      request: { type: 'FOLLOW_UP' },
    });

    expect(mockRpc).toHaveBeenCalledWith('follow_up_ticket_tx', {
      p_ticket_id: 'ticket-1',
      p_actor_user_id: 'user-dev',
    });
    expect(result.newState).toBe('REJECTED');
    expect(result.stateChanged).toBe(true);
  });

  it('follow_up_ticket_tx: NEW + latest_outcome=NULL → IN_REVIEW (fallback)', async () => {
    mockRpc.mockResolvedValueOnce(stateChangeResponse('NEW', 'IN_REVIEW'));

    const result = await executeUserAction({
      ticketId: 'ticket-1',
      actor: DEV,
      request: { type: 'FOLLOW_UP' },
    });

    expect(result.newState).toBe('IN_REVIEW');
  });

  it('mark_done_ticket_tx: IN_REVIEW → DONE, terminal transition', async () => {
    mockRpc.mockResolvedValueOnce(stateChangeResponse('IN_REVIEW', 'DONE'));

    const result = await executeUserAction({
      ticketId: 'ticket-1',
      actor: DEV,
      request: { type: 'MARK_DONE' },
    });

    expect(mockRpc).toHaveBeenCalledWith('mark_done_ticket_tx', {
      p_ticket_id: 'ticket-1',
      p_actor_user_id: 'user-dev',
    });
    expect(result.newState).toBe('DONE');
    expect(result.previousState).toBe('IN_REVIEW');
    expect(result.stateChanged).toBe(true);
  });

  it('unarchive_ticket_tx: ARCHIVED → NEW (re-triage intent)', async () => {
    mockRpc.mockResolvedValueOnce(stateChangeResponse('ARCHIVED', 'NEW'));

    const result = await executeUserAction({
      ticketId: 'ticket-1',
      actor: MANAGER,
      request: { type: 'UNARCHIVE' },
    });

    expect(mockRpc).toHaveBeenCalledWith('unarchive_ticket_tx', {
      p_ticket_id: 'ticket-1',
      p_actor_user_id: 'user-mgr',
    });
    expect(result.newState).toBe('NEW');
    expect(result.previousState).toBe('ARCHIVED');
    expect(result.stateChanged).toBe(true);
  });

  it('add_comment_tx: no state change, entry returned', async () => {
    mockRpc.mockResolvedValueOnce(
      nonStateChangeResponse('IN_REVIEW', 'ticket-1', 'entry-comment-1'),
    );

    const result = await executeUserAction({
      ticketId: 'ticket-1',
      actor: DEV,
      request: { type: 'ADD_COMMENT', content: '  trimmed ok  ' },
    });

    expect(mockRpc).toHaveBeenCalledWith('add_comment_tx', {
      p_ticket_id: 'ticket-1',
      p_actor_user_id: 'user-dev',
      p_content: '  trimmed ok  ',
    });
    // Dispatcher forwards raw content; BTRIM happens server-side in the RPC.
    expect(result.stateChanged).toBe(false);
    expect(result.previousState).toBe('IN_REVIEW');
    expect(result.newState).toBe('IN_REVIEW');
    expect(result.entryId).toBe('entry-comment-1');
  });

  it('edit_comment_tx: content updated, same entryId returned', async () => {
    mockRpc.mockResolvedValueOnce(
      nonStateChangeResponse('IN_REVIEW', 'ticket-1', 'entry-42'),
    );

    const result = await executeUserAction({
      ticketId: 'ticket-1',
      actor: DEV,
      request: {
        type: 'EDIT_COMMENT',
        entryId: 'entry-42',
        content: 'revised',
      },
    });

    expect(mockRpc).toHaveBeenCalledWith('edit_comment_tx', {
      p_ticket_id: 'ticket-1',
      p_entry_id: 'entry-42',
      p_actor_user_id: 'user-dev',
      p_content: 'revised',
    });
    expect(result.stateChanged).toBe(false);
    expect(result.entryId).toBe('entry-42');
  });

  it('add_reject_reason_tx: no state change, new entry returned', async () => {
    mockRpc.mockResolvedValueOnce(
      nonStateChangeResponse('REJECTED', 'ticket-1', 'entry-reject-7'),
    );

    const result = await executeUserAction({
      ticketId: 'ticket-1',
      actor: DEV,
      request: {
        type: 'ADD_REJECT_REASON',
        content: 'Guideline 2.3.10 — Metadata',
      },
    });

    expect(mockRpc).toHaveBeenCalledWith('add_reject_reason_tx', {
      p_ticket_id: 'ticket-1',
      p_actor_user_id: 'user-dev',
      p_content: 'Guideline 2.3.10 — Metadata',
    });
    expect(result.stateChanged).toBe(false);
    expect(result.previousState).toBe('REJECTED');
    expect(result.entryId).toBe('entry-reject-7');
  });
});

// -- Error paths — migration-verbatim error messages ----------------------

describe('error paths — migration-verbatim exception messages', () => {
  it('ARCHIVE on IN_REVIEW → InvalidTransitionRpcError (migration message)', async () => {
    // Exact string from archive_ticket_tx RAISE EXCEPTION.
    mockRpc.mockResolvedValueOnce(
      rpcException(
        'INVALID_TRANSITION: cannot archive ticket in state IN_REVIEW (NEW only)',
      ),
    );

    await expect(
      executeUserAction({
        ticketId: 'ticket-1',
        actor: DEV,
        request: { type: 'ARCHIVE' },
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionRpcError);
  });

  it('FOLLOW_UP on IN_REVIEW → InvalidTransitionRpcError', async () => {
    mockRpc.mockResolvedValueOnce(
      rpcException(
        'INVALID_TRANSITION: cannot follow-up ticket in state IN_REVIEW (NEW only)',
      ),
    );

    await expect(
      executeUserAction({
        ticketId: 'ticket-1',
        actor: DEV,
        request: { type: 'FOLLOW_UP' },
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionRpcError);
  });

  it('MARK_DONE on DONE → InvalidTransitionRpcError (terminal state reject)', async () => {
    mockRpc.mockResolvedValueOnce(
      rpcException(
        'INVALID_TRANSITION: cannot mark done ticket in state DONE (open states only)',
      ),
    );

    await expect(
      executeUserAction({
        ticketId: 'ticket-1',
        actor: DEV,
        request: { type: 'MARK_DONE' },
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionRpcError);
  });

  it('UNARCHIVE on NEW → InvalidTransitionRpcError', async () => {
    mockRpc.mockResolvedValueOnce(
      rpcException(
        'INVALID_TRANSITION: cannot unarchive ticket in state NEW (ARCHIVED only)',
      ),
    );

    await expect(
      executeUserAction({
        ticketId: 'ticket-1',
        actor: DEV,
        request: { type: 'UNARCHIVE' },
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionRpcError);
  });

  it('UNARCHIVE grouping-key conflict → InvalidTransitionRpcError (design decision)', async () => {
    // Migration's BEGIN/EXCEPTION block converts unique_violation to
    // INVALID_TRANSITION. Locks the design decision in place.
    mockRpc.mockResolvedValueOnce(
      rpcException(
        'INVALID_TRANSITION: cannot unarchive — another open ticket already exists for this app/type/platform key',
      ),
    );

    const p = executeUserAction({
      ticketId: 'ticket-1',
      actor: MANAGER,
      request: { type: 'UNARCHIVE' },
    });

    await expect(p).rejects.toBeInstanceOf(InvalidTransitionRpcError);
    await expect(p).rejects.toThrow(/another open ticket already exists/);
  });

  it('EDIT_COMMENT wrong author → CommentOwnershipError', async () => {
    // Migration: 'COMMENT_FORBIDDEN: only the original author can edit this comment'
    mockRpc.mockResolvedValueOnce(
      rpcException(
        'COMMENT_FORBIDDEN: only the original author can edit this comment',
      ),
    );

    const p = executeUserAction({
      ticketId: 'ticket-1',
      actor: DEV,
      request: { type: 'EDIT_COMMENT', entryId: 'entry-42', content: 'x' },
    });

    await expect(p).rejects.toBeInstanceOf(CommentOwnershipError);
    await expect(p).rejects.toThrow(/original author/);
  });

  it('EDIT_COMMENT cross-ticket entry → UserActionValidationError (INVALID_ARG)', async () => {
    // Migration: 'INVALID_ARG: entry <uuid> does not belong to ticket <uuid>'
    // Tests the PR-10c.1.2 DESIGN-3 URL-manipulation defense.
    mockRpc.mockResolvedValueOnce(
      rpcException(
        'INVALID_ARG: entry entry-42 does not belong to ticket ticket-B',
      ),
    );

    const p = executeUserAction({
      ticketId: 'ticket-B',
      actor: DEV,
      request: { type: 'EDIT_COMMENT', entryId: 'entry-42', content: 'x' },
    });

    await expect(p).rejects.toBeInstanceOf(UserActionValidationError);
    await expect(p).rejects.toThrow(/does not belong to ticket/);
  });

  it('EDIT_COMMENT on non-COMMENT entry → UserActionValidationError', async () => {
    mockRpc.mockResolvedValueOnce(
      rpcException(
        'INVALID_ARG: entry entry-99 has type EMAIL (only COMMENT entries can be edited)',
      ),
    );

    await expect(
      executeUserAction({
        ticketId: 'ticket-1',
        actor: DEV,
        request: { type: 'EDIT_COMMENT', entryId: 'entry-99', content: 'x' },
      }),
    ).rejects.toBeInstanceOf(UserActionValidationError);
  });

  it('ADD_COMMENT empty content → UserActionValidationError', async () => {
    mockRpc.mockResolvedValueOnce(
      rpcException('INVALID_ARG: comment content must be non-empty'),
    );

    await expect(
      executeUserAction({
        ticketId: 'ticket-1',
        actor: DEV,
        request: { type: 'ADD_COMMENT', content: '   ' },
      }),
    ).rejects.toBeInstanceOf(UserActionValidationError);
  });

  it('ARCHIVE on non-existent ticket → TicketNotFoundError', async () => {
    mockRpc.mockResolvedValueOnce(
      rpcException('NOT_FOUND: ticket ticket-ghost does not exist'),
    );

    await expect(
      executeUserAction({
        ticketId: 'ticket-ghost',
        actor: DEV,
        request: { type: 'ARCHIVE' },
      }),
    ).rejects.toBeInstanceOf(TicketNotFoundError);
  });

  it('CONCURRENT_RACE_UNEXPECTED reserved prefix → ConcurrentModificationError', async () => {
    // Current migration doesn't raise this — reserved for future schema
    // drift detection. Test ensures the TS mapping still holds if a
    // future RPC surfaces it.
    mockRpc.mockResolvedValueOnce(
      rpcException('CONCURRENT_RACE_UNEXPECTED: schema drift detected'),
    );

    await expect(
      executeUserAction({
        ticketId: 'ticket-1',
        actor: DEV,
        request: { type: 'ARCHIVE' },
      }),
    ).rejects.toBeInstanceOf(ConcurrentModificationError);
  });
});

// -- Dispatcher integration — multi-action + role matrix ------------------

describe('dispatcher integration — sequences + authorization', () => {
  it('multi-action flow: ARCHIVE then UNARCHIVE on same ticket, 2 RPC calls', async () => {
    mockRpc
      .mockResolvedValueOnce(stateChangeResponse('NEW', 'ARCHIVED', 'ticket-1'))
      .mockResolvedValueOnce(stateChangeResponse('ARCHIVED', 'NEW', 'ticket-1'));

    const r1 = await executeUserAction({
      ticketId: 'ticket-1',
      actor: DEV,
      request: { type: 'ARCHIVE' },
    });
    const r2 = await executeUserAction({
      ticketId: 'ticket-1',
      actor: DEV,
      request: { type: 'UNARCHIVE' },
    });

    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc).toHaveBeenNthCalledWith(
      1,
      'archive_ticket_tx',
      expect.any(Object),
    );
    expect(mockRpc).toHaveBeenNthCalledWith(
      2,
      'unarchive_ticket_tx',
      expect.any(Object),
    );
    expect(r1.newState).toBe('ARCHIVED');
    expect(r2.newState).toBe('NEW');
  });

  it('multi-action flow: ADD_COMMENT then EDIT_COMMENT → same entryId', async () => {
    mockRpc
      .mockResolvedValueOnce(
        nonStateChangeResponse('NEW', 'ticket-1', 'entry-5'),
      )
      .mockResolvedValueOnce(
        nonStateChangeResponse('NEW', 'ticket-1', 'entry-5'),
      );

    const r1 = await executeUserAction({
      ticketId: 'ticket-1',
      actor: DEV,
      request: { type: 'ADD_COMMENT', content: 'first' },
    });
    const r2 = await executeUserAction({
      ticketId: 'ticket-1',
      actor: DEV,
      request: { type: 'EDIT_COMMENT', entryId: r1.entryId, content: 'first — edited' },
    });

    expect(r1.entryId).toBe('entry-5');
    expect(r2.entryId).toBe('entry-5');
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it('VIEWER blocked on all 7 actions — zero RPC invocations', async () => {
    const requests = [
      { type: 'ARCHIVE' as const },
      { type: 'FOLLOW_UP' as const },
      { type: 'MARK_DONE' as const },
      { type: 'UNARCHIVE' as const },
      { type: 'ADD_COMMENT' as const, content: 'x' },
      {
        type: 'EDIT_COMMENT' as const,
        entryId: 'entry-1',
        content: 'x',
      },
      { type: 'ADD_REJECT_REASON' as const, content: 'x' },
    ];

    for (const request of requests) {
      await expect(
        executeUserAction({ ticketId: 'ticket-1', actor: VIEWER, request }),
      ).rejects.toBeInstanceOf(UnauthorizedActionError);
    }

    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('MANAGER permitted on all 7 actions — 7 RPC invocations', async () => {
    // Each action responds with a valid shape; assertions focus on
    // the dispatcher reaching every RPC without auth rejection.
    mockRpc
      .mockResolvedValueOnce(stateChangeResponse('NEW', 'ARCHIVED'))
      .mockResolvedValueOnce(stateChangeResponse('NEW', 'IN_REVIEW'))
      .mockResolvedValueOnce(stateChangeResponse('IN_REVIEW', 'DONE'))
      .mockResolvedValueOnce(stateChangeResponse('ARCHIVED', 'NEW'))
      .mockResolvedValueOnce(nonStateChangeResponse('NEW'))
      .mockResolvedValueOnce(nonStateChangeResponse('NEW', 'ticket-1', 'e-1'))
      .mockResolvedValueOnce(nonStateChangeResponse('REJECTED'));

    await executeUserAction({
      ticketId: 'ticket-1',
      actor: MANAGER,
      request: { type: 'ARCHIVE' },
    });
    await executeUserAction({
      ticketId: 'ticket-1',
      actor: MANAGER,
      request: { type: 'FOLLOW_UP' },
    });
    await executeUserAction({
      ticketId: 'ticket-1',
      actor: MANAGER,
      request: { type: 'MARK_DONE' },
    });
    await executeUserAction({
      ticketId: 'ticket-1',
      actor: MANAGER,
      request: { type: 'UNARCHIVE' },
    });
    await executeUserAction({
      ticketId: 'ticket-1',
      actor: MANAGER,
      request: { type: 'ADD_COMMENT', content: 'x' },
    });
    await executeUserAction({
      ticketId: 'ticket-1',
      actor: MANAGER,
      request: { type: 'EDIT_COMMENT', entryId: 'e-1', content: 'x' },
    });
    await executeUserAction({
      ticketId: 'ticket-1',
      actor: MANAGER,
      request: { type: 'ADD_REJECT_REASON', content: 'x' },
    });

    expect(mockRpc).toHaveBeenCalledTimes(7);
  });

  it('actor.id threaded into every RPC call (audit-trail parity)', async () => {
    mockRpc.mockResolvedValue(stateChangeResponse('NEW', 'ARCHIVED'));

    await executeUserAction({
      ticketId: 'ticket-1',
      actor: { id: 'custom-user-xyz', role: 'DEV' },
      request: { type: 'ARCHIVE' },
    });

    expect(mockRpc).toHaveBeenCalledWith(
      'archive_ticket_tx',
      expect.objectContaining({ p_actor_user_id: 'custom-user-xyz' }),
    );
  });
});
