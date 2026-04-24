import { describe, expect, it } from 'vitest';

import type { StoreRole } from '../auth';

import {
  assertCanPerformAction,
  AUTH_MATRIX,
  canPerformAction,
  UnauthorizedActionError,
  type TicketUserAction,
} from './auth';

const ALL_ACTIONS: TicketUserAction[] = [
  'ARCHIVE',
  'FOLLOW_UP',
  'MARK_DONE',
  'UNARCHIVE',
  'ADD_COMMENT',
  'EDIT_COMMENT',
  'ADD_REJECT_REASON',
];

// -- assertCanPerformAction ------------------------------------------------

describe('assertCanPerformAction — VIEWER (read-only per spec §7.2)', () => {
  it.each(ALL_ACTIONS)('VIEWER + %s throws UnauthorizedActionError', (action) => {
    expect(() => assertCanPerformAction('VIEWER', action)).toThrow(
      UnauthorizedActionError,
    );
  });
});

describe('assertCanPerformAction — DEV (permissive per spec §7.2)', () => {
  it.each(ALL_ACTIONS)('DEV + %s passes', (action) => {
    expect(() => assertCanPerformAction('DEV', action)).not.toThrow();
  });
});

describe('assertCanPerformAction — MANAGER (full access)', () => {
  it.each(ALL_ACTIONS)('MANAGER + %s passes', (action) => {
    expect(() => assertCanPerformAction('MANAGER', action)).not.toThrow();
  });
});

describe('UnauthorizedActionError payload', () => {
  it('carries role + action as structured fields', () => {
    try {
      assertCanPerformAction('VIEWER', 'ARCHIVE');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedActionError);
      const e = err as UnauthorizedActionError;
      expect(e.role).toBe('VIEWER');
      expect(e.action).toBe('ARCHIVE');
      expect(e.message).toContain('VIEWER');
      expect(e.message).toContain('ARCHIVE');
      expect(e.name).toBe('UnauthorizedActionError');
    }
  });
});

// -- canPerformAction ------------------------------------------------------

describe('canPerformAction (boolean form for UI gating)', () => {
  it.each<[StoreRole, TicketUserAction, boolean]>([
    ['VIEWER', 'ARCHIVE', false],
    ['VIEWER', 'ADD_COMMENT', false],
    ['VIEWER', 'EDIT_COMMENT', false],
    ['DEV', 'ARCHIVE', true],
    ['DEV', 'EDIT_COMMENT', true],
    ['MANAGER', 'ARCHIVE', true],
    ['MANAGER', 'UNARCHIVE', true],
  ])('(%s, %s) → %s', (role, action, expected) => {
    expect(canPerformAction(role, action)).toBe(expected);
  });
});

// -- Matrix consistency ----------------------------------------------------

describe('AUTH_MATRIX shape', () => {
  it('covers all seven user actions', () => {
    for (const action of ALL_ACTIONS) {
      expect(AUTH_MATRIX[action]).toBeDefined();
      expect(Array.isArray(AUTH_MATRIX[action])).toBe(true);
    }
  });

  it('VIEWER is absent from every action (spec §7.2: read-only)', () => {
    for (const action of ALL_ACTIONS) {
      expect(AUTH_MATRIX[action]).not.toContain('VIEWER');
    }
  });
});
