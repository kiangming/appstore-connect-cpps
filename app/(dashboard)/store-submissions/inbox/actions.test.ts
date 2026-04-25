import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CommentOwnershipError,
  ConcurrentModificationError,
  InvalidTransitionRpcError,
  TicketNotFoundError,
  UserActionValidationError,
} from '@/lib/store-submissions/tickets/user-actions';

// === Hoisted mocks ===

const {
  mockGetServerSession,
  mockRevalidatePath,
  mockRequireStoreRole,
  mockExecuteUserAction,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockRequireStoreRole: vi.fn(),
  mockExecuteUserAction: vi.fn(),
}));

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }));
vi.mock('next/cache', () => ({ revalidatePath: mockRevalidatePath }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

vi.mock('@/lib/store-submissions/auth', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/store-submissions/auth')
  >('@/lib/store-submissions/auth');
  return { ...actual, requireStoreRole: mockRequireStoreRole };
});

vi.mock('@/lib/store-submissions/tickets/user-actions', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/store-submissions/tickets/user-actions')
  >('@/lib/store-submissions/tickets/user-actions');
  return { ...actual, executeUserAction: mockExecuteUserAction };
});

// === Imports AFTER mocks ===

import { StoreForbiddenError, StoreUnauthorizedError } from '@/lib/store-submissions/auth';
import {
  addCommentAction,
  addRejectReasonAction,
  archiveTicketAction,
  editCommentAction,
  followUpTicketAction,
  markDoneTicketAction,
  unarchiveTicketAction,
} from './actions';

// === Helpers ===

const TICKET_ID = '11111111-1111-4111-8111-111111111111';

function setSessionDev() {
  mockGetServerSession.mockResolvedValue({ user: { email: 'dev@company.com' } });
  mockRequireStoreRole.mockResolvedValue({
    id: 'user-dev',
    email: 'dev@company.com',
    role: 'DEV',
    display_name: 'Dev One',
    avatar_url: null,
    status: 'active',
  });
}

function setSessionManager() {
  mockGetServerSession.mockResolvedValue({ user: { email: 'mgr@company.com' } });
  mockRequireStoreRole.mockResolvedValue({
    id: 'user-mgr',
    email: 'mgr@company.com',
    role: 'MANAGER',
    display_name: 'Mgr',
    avatar_url: null,
    status: 'active',
  });
}

function setNoSession() {
  mockGetServerSession.mockResolvedValue(null);
  mockRequireStoreRole.mockRejectedValue(new StoreUnauthorizedError('No session'));
}

function setSessionViewer() {
  mockGetServerSession.mockResolvedValue({ user: { email: 'viewer@company.com' } });
  mockRequireStoreRole.mockRejectedValue(
    new StoreForbiddenError('Required role: DEV or MANAGER. Current role: VIEWER.'),
  );
}

beforeEach(() => {
  mockGetServerSession.mockReset();
  mockRevalidatePath.mockReset();
  mockRequireStoreRole.mockReset();
  mockExecuteUserAction.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// -- Input validation ------------------------------------------------------

describe('Server Actions — input validation', () => {
  it('rejects empty ticketId with VALIDATION error, no session check', async () => {
    const result = await archiveTicketAction('');
    expect(result).toEqual({
      ok: false,
      error: { code: 'VALIDATION', message: 'ticketId is required' },
    });
    expect(mockGetServerSession).not.toHaveBeenCalled();
    expect(mockExecuteUserAction).not.toHaveBeenCalled();
  });
});

// -- Auth gate (shared across all 4 actions) -------------------------------

describe('Server Actions — auth gate', () => {
  it('archive: no session → UNAUTHORIZED, no executeUserAction call', async () => {
    setNoSession();

    const result = await archiveTicketAction(TICKET_ID);

    expect(result).toEqual({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: 'No session' },
    });
    expect(mockExecuteUserAction).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it('follow-up: VIEWER → FORBIDDEN', async () => {
    setSessionViewer();

    const result = await followUpTicketAction(TICKET_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
    }
    expect(mockExecuteUserAction).not.toHaveBeenCalled();
  });

  it('mark done: VIEWER → FORBIDDEN', async () => {
    setSessionViewer();
    const result = await markDoneTicketAction(TICKET_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN');
  });

  it('unarchive: VIEWER → FORBIDDEN', async () => {
    setSessionViewer();
    const result = await unarchiveTicketAction(TICKET_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN');
  });
});

// -- Happy paths: dispatch + revalidate ------------------------------------

describe('Server Actions — happy paths', () => {
  it('archive: DEV → executeUserAction({ARCHIVE}) + revalidatePath', async () => {
    setSessionDev();
    mockExecuteUserAction.mockResolvedValue({
      ticketId: TICKET_ID,
      previousState: 'NEW',
      newState: 'ARCHIVED',
      stateChanged: true,
      entryId: 'entry-1',
    });

    const result = await archiveTicketAction(TICKET_ID);

    expect(mockExecuteUserAction).toHaveBeenCalledWith({
      ticketId: TICKET_ID,
      actor: { id: 'user-dev', role: 'DEV' },
      request: { type: 'ARCHIVE' },
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith('/store-submissions/inbox');
    expect(result).toEqual({
      ok: true,
      data: {
        ticketId: TICKET_ID,
        previousState: 'NEW',
        newState: 'ARCHIVED',
        entryId: 'entry-1',
      },
    });
  });

  it('follow-up: MANAGER → executeUserAction({FOLLOW_UP}) + newState forwarded', async () => {
    setSessionManager();
    mockExecuteUserAction.mockResolvedValue({
      ticketId: TICKET_ID,
      previousState: 'NEW',
      newState: 'REJECTED',
      stateChanged: true,
      entryId: 'entry-2',
    });

    const result = await followUpTicketAction(TICKET_ID);

    expect(mockExecuteUserAction).toHaveBeenCalledWith(
      expect.objectContaining({
        request: { type: 'FOLLOW_UP' },
        actor: { id: 'user-mgr', role: 'MANAGER' },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.newState).toBe('REJECTED');
  });

  it('mark done: DEV → executeUserAction({MARK_DONE})', async () => {
    setSessionDev();
    mockExecuteUserAction.mockResolvedValue({
      ticketId: TICKET_ID,
      previousState: 'IN_REVIEW',
      newState: 'DONE',
      stateChanged: true,
      entryId: 'entry-3',
    });

    const result = await markDoneTicketAction(TICKET_ID);

    expect(mockExecuteUserAction).toHaveBeenCalledWith(
      expect.objectContaining({ request: { type: 'MARK_DONE' } }),
    );
    expect(result.ok).toBe(true);
  });

  it('unarchive: MANAGER → executeUserAction({UNARCHIVE})', async () => {
    setSessionManager();
    mockExecuteUserAction.mockResolvedValue({
      ticketId: TICKET_ID,
      previousState: 'ARCHIVED',
      newState: 'NEW',
      stateChanged: true,
      entryId: 'entry-4',
    });

    const result = await unarchiveTicketAction(TICKET_ID);

    expect(mockExecuteUserAction).toHaveBeenCalledWith(
      expect.objectContaining({ request: { type: 'UNARCHIVE' } }),
    );
    expect(result.ok).toBe(true);
  });
});

// -- Dispatcher error mapping → ActionError --------------------------------

describe('Server Actions — dispatcher error → ActionError mapping', () => {
  it('TicketNotFoundError → NOT_FOUND code with human-readable message', async () => {
    setSessionDev();
    mockExecuteUserAction.mockRejectedValue(
      new TicketNotFoundError('NOT_FOUND: ticket abc does not exist'),
    );

    const result = await archiveTicketAction(TICKET_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_FOUND');
      expect(result.error.message).toMatch(/no longer exists/);
    }
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it('InvalidTransitionRpcError (generic) → INVALID_TRANSITION, message stripped of prefix', async () => {
    setSessionDev();
    mockExecuteUserAction.mockRejectedValue(
      new InvalidTransitionRpcError(
        'INVALID_TRANSITION: cannot archive ticket in state IN_REVIEW (NEW only)',
      ),
    );

    const result = await archiveTicketAction(TICKET_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_TRANSITION');
      // Prefix "[user-actions] invalid transition: INVALID_TRANSITION: " stripped.
      expect(result.error.message).toBe(
        'cannot archive ticket in state IN_REVIEW (NEW only)',
      );
    }
  });

  it('InvalidTransitionRpcError (UNARCHIVE grouping conflict) → CONFLICT code (escalated)', async () => {
    setSessionManager();
    mockExecuteUserAction.mockRejectedValue(
      new InvalidTransitionRpcError(
        'INVALID_TRANSITION: cannot unarchive — another open ticket already exists for this app/type/platform key',
      ),
    );

    const result = await unarchiveTicketAction(TICKET_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONFLICT');
      expect(result.error.message).toMatch(/Archive or resolve/);
    }
  });

  it('UserActionValidationError → VALIDATION code', async () => {
    setSessionDev();
    mockExecuteUserAction.mockRejectedValue(
      new UserActionValidationError('INVALID_ARG: something'),
    );

    const result = await archiveTicketAction(TICKET_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
  });

  it('ConcurrentModificationError → RACE code', async () => {
    setSessionDev();
    mockExecuteUserAction.mockRejectedValue(
      new ConcurrentModificationError('CONCURRENT_RACE_UNEXPECTED: drift'),
    );

    const result = await archiveTicketAction(TICKET_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('RACE');
      expect(result.error.message).toMatch(/concurrently/);
    }
  });

  it('CommentOwnershipError (unreachable here but mapping is total) → FORBIDDEN', async () => {
    // Defense for future refactor: if comment actions ever route through
    // this helper, the mapping must not drop the error class.
    setSessionDev();
    mockExecuteUserAction.mockRejectedValue(
      new CommentOwnershipError('COMMENT_FORBIDDEN: unlikely'),
    );

    const result = await archiveTicketAction(TICKET_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN');
  });

  it('unknown error class → DB_ERROR fallback', async () => {
    setSessionDev();
    mockExecuteUserAction.mockRejectedValue(
      new Error('[user-actions] RPC failed: totally unexpected'),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await archiveTicketAction(TICKET_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('DB_ERROR');
      expect(result.error.message).toMatch(/Unexpected error/);
    }
  });
});

// -- Per-action request-type contract (state transitions) -----------------

describe('Server Actions — state-transition request-type routing', () => {
  it.each([
    ['archive', archiveTicketAction, 'ARCHIVE'],
    ['follow-up', followUpTicketAction, 'FOLLOW_UP'],
    ['mark done', markDoneTicketAction, 'MARK_DONE'],
    ['unarchive', unarchiveTicketAction, 'UNARCHIVE'],
  ] as const)(
    '%s sends request.type=%s',
    async (_label, action, expectedType) => {
      setSessionDev();
      mockExecuteUserAction.mockResolvedValue({
        ticketId: TICKET_ID,
        previousState: 'NEW',
        newState: 'NEW',
        stateChanged: false,
        entryId: 'e-1',
      });

      await action(TICKET_ID);

      expect(mockExecuteUserAction).toHaveBeenCalledWith(
        expect.objectContaining({
          request: { type: expectedType },
        }),
      );
    },
  );
});

// -- Comment + reject-reason actions (PR-10c.3.1) -------------------------

const ENTRY_ID = '22222222-2222-4222-8222-222222222222';

describe('addCommentAction', () => {
  it('happy path: forwards content to dispatcher with ADD_COMMENT type', async () => {
    setSessionDev();
    mockExecuteUserAction.mockResolvedValue({
      ticketId: TICKET_ID,
      previousState: 'IN_REVIEW',
      newState: 'IN_REVIEW',
      stateChanged: false,
      entryId: 'entry-c1',
    });

    const result = await addCommentAction(TICKET_ID, '  trimmed by RPC  ');

    // Dispatcher receives raw content; BTRIM lives server-side in RPC.
    expect(mockExecuteUserAction).toHaveBeenCalledWith({
      ticketId: TICKET_ID,
      actor: { id: 'user-dev', role: 'DEV' },
      request: { type: 'ADD_COMMENT', content: '  trimmed by RPC  ' },
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith('/store-submissions/inbox');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.entryId).toBe('entry-c1');
      expect(result.data.previousState).toBe(result.data.newState);
    }
  });

  it('VIEWER → FORBIDDEN, no dispatcher call', async () => {
    setSessionViewer();
    const result = await addCommentAction(TICKET_ID, 'hello');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN');
    expect(mockExecuteUserAction).not.toHaveBeenCalled();
  });

  it('non-string content → VALIDATION before session check', async () => {
    const result = await addCommentAction(
      TICKET_ID,
      undefined as unknown as string,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });

  it('RPC INVALID_ARG (empty content) → VALIDATION', async () => {
    setSessionDev();
    mockExecuteUserAction.mockRejectedValue(
      new (await import('@/lib/store-submissions/tickets/user-actions')).UserActionValidationError(
        'INVALID_ARG: comment content must be non-empty',
      ),
    );

    const result = await addCommentAction(TICKET_ID, '   ');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
  });
});

describe('editCommentAction', () => {
  it('happy path: forwards ticketId + entryId + content', async () => {
    setSessionDev();
    mockExecuteUserAction.mockResolvedValue({
      ticketId: TICKET_ID,
      previousState: 'NEW',
      newState: 'NEW',
      stateChanged: false,
      entryId: ENTRY_ID,
    });

    const result = await editCommentAction(TICKET_ID, ENTRY_ID, 'revised');

    expect(mockExecuteUserAction).toHaveBeenCalledWith({
      ticketId: TICKET_ID,
      actor: { id: 'user-dev', role: 'DEV' },
      request: {
        type: 'EDIT_COMMENT',
        entryId: ENTRY_ID,
        content: 'revised',
      },
    });
    expect(result.ok).toBe(true);
  });

  it('missing entryId → VALIDATION before session check', async () => {
    const result = await editCommentAction(TICKET_ID, '', 'content');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });

  it('CommentOwnershipError (not author) → FORBIDDEN', async () => {
    setSessionDev();
    const { CommentOwnershipError: CO } = await import(
      '@/lib/store-submissions/tickets/user-actions'
    );
    mockExecuteUserAction.mockRejectedValue(
      new CO('COMMENT_FORBIDDEN: only the original author can edit this comment'),
    );

    const result = await editCommentAction(TICKET_ID, ENTRY_ID, 'x');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.message).toMatch(/original author/);
    }
  });

  it('cross-ticket entry (RPC INVALID_ARG) → VALIDATION', async () => {
    setSessionDev();
    const { UserActionValidationError: UV } = await import(
      '@/lib/store-submissions/tickets/user-actions'
    );
    mockExecuteUserAction.mockRejectedValue(
      new UV(
        'INVALID_ARG: entry entry-42 does not belong to ticket ticket-B',
      ),
    );

    const result = await editCommentAction(TICKET_ID, ENTRY_ID, 'x');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
  });
});

describe('addRejectReasonAction', () => {
  it('happy path: forwards content with ADD_REJECT_REASON type', async () => {
    setSessionDev();
    mockExecuteUserAction.mockResolvedValue({
      ticketId: TICKET_ID,
      previousState: 'REJECTED',
      newState: 'REJECTED',
      stateChanged: false,
      entryId: 'entry-r1',
    });

    const result = await addRejectReasonAction(
      TICKET_ID,
      'Guideline 2.3.10 — Metadata',
    );

    expect(mockExecuteUserAction).toHaveBeenCalledWith({
      ticketId: TICKET_ID,
      actor: { id: 'user-dev', role: 'DEV' },
      request: {
        type: 'ADD_REJECT_REASON',
        content: 'Guideline 2.3.10 — Metadata',
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.entryId).toBe('entry-r1');
  });

  it('VIEWER → FORBIDDEN', async () => {
    setSessionViewer();
    const result = await addRejectReasonAction(TICKET_ID, 'x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN');
  });
});
