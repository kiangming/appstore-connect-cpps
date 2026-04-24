import { describe, expect, it } from 'vitest';

import type { TicketOutcome, TicketState } from '../schemas/ticket';

import {
  canTransition,
  deriveStateFromUserAction,
  InvalidTransitionError,
  isTerminalState,
  type UserAction,
} from './state-machine';

// -- deriveStateFromUserAction --------------------------------------------

describe('deriveStateFromUserAction — ARCHIVE', () => {
  it('NEW → ARCHIVED', () => {
    expect(deriveStateFromUserAction('NEW', 'ARCHIVE', null)).toBe('ARCHIVED');
  });

  it.each<TicketState>(['IN_REVIEW', 'REJECTED', 'APPROVED', 'DONE', 'ARCHIVED'])(
    '%s throws (spec §4.2: ARCHIVE only legal from NEW)',
    (from) => {
      expect(() => deriveStateFromUserAction(from, 'ARCHIVE', null)).toThrow(
        InvalidTransitionError,
      );
    },
  );
});

describe('deriveStateFromUserAction — FOLLOW_UP', () => {
  it('NEW + null outcome → IN_REVIEW (unclassified fallback per spec §4.2)', () => {
    expect(deriveStateFromUserAction('NEW', 'FOLLOW_UP', null)).toBe('IN_REVIEW');
  });

  it.each<[TicketOutcome, TicketState]>([
    ['IN_REVIEW', 'IN_REVIEW'],
    ['REJECTED', 'REJECTED'],
    ['APPROVED', 'APPROVED'],
  ])('NEW + outcome=%s → %s', (outcome, expected) => {
    expect(deriveStateFromUserAction('NEW', 'FOLLOW_UP', outcome)).toBe(expected);
  });

  it.each<TicketState>(['IN_REVIEW', 'REJECTED', 'APPROVED', 'DONE', 'ARCHIVED'])(
    '%s throws (spec §4.2: FOLLOW_UP only legal from NEW)',
    (from) => {
      expect(() =>
        deriveStateFromUserAction(from, 'FOLLOW_UP', 'IN_REVIEW'),
      ).toThrow(InvalidTransitionError);
    },
  );
});

describe('deriveStateFromUserAction — MARK_DONE', () => {
  it.each<TicketState>(['NEW', 'IN_REVIEW', 'REJECTED'])(
    '%s → DONE (any open state)',
    (from) => {
      expect(deriveStateFromUserAction(from, 'MARK_DONE', null)).toBe('DONE');
    },
  );

  it.each<TicketState>(['APPROVED', 'DONE', 'ARCHIVED'])(
    '%s throws (terminal states cannot mark-done)',
    (from) => {
      expect(() => deriveStateFromUserAction(from, 'MARK_DONE', null)).toThrow(
        InvalidTransitionError,
      );
    },
  );
});

describe('deriveStateFromUserAction — UNARCHIVE', () => {
  // Design-intent test — per spec §4.2 unarchive re-triage dumps the
  // ticket back to NEW even if it accumulated emails before archive.
  // Future-self: do NOT "fix" this to restore the pre-archive state;
  // the ticket is meant to be re-reviewed by a Manager from scratch.
  it('ARCHIVED → NEW (intentional re-triage, not pre-archive restore)', () => {
    expect(deriveStateFromUserAction('ARCHIVED', 'UNARCHIVE', null)).toBe('NEW');
  });

  it.each<TicketState>(['NEW', 'IN_REVIEW', 'REJECTED', 'APPROVED', 'DONE'])(
    '%s throws (UNARCHIVE only legal from ARCHIVED)',
    (from) => {
      expect(() => deriveStateFromUserAction(from, 'UNARCHIVE', null)).toThrow(
        InvalidTransitionError,
      );
    },
  );
});

describe('deriveStateFromUserAction — error payload', () => {
  it('InvalidTransitionError carries currentState + action + reason', () => {
    try {
      deriveStateFromUserAction('APPROVED', 'ARCHIVE', null);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      const e = err as InvalidTransitionError;
      expect(e.currentState).toBe('APPROVED');
      expect(e.action).toBe('ARCHIVE');
      expect(e.reason).toMatch(/Can only archive NEW/);
      expect(e.message).toContain('APPROVED');
      expect(e.message).toContain('ARCHIVE');
    }
  });
});

// -- isTerminalState -------------------------------------------------------

describe('isTerminalState', () => {
  it.each<TicketState>(['APPROVED', 'DONE', 'ARCHIVED'])('%s → true', (s) => {
    expect(isTerminalState(s)).toBe(true);
  });

  it.each<TicketState>(['NEW', 'IN_REVIEW', 'REJECTED'])('%s → false', (s) => {
    expect(isTerminalState(s)).toBe(false);
  });
});

// -- canTransition ---------------------------------------------------------

describe('canTransition', () => {
  it.each<[TicketState, UserAction, boolean]>([
    ['NEW', 'ARCHIVE', true],
    ['NEW', 'FOLLOW_UP', true],
    ['NEW', 'MARK_DONE', true],
    ['NEW', 'UNARCHIVE', false],
    ['IN_REVIEW', 'ARCHIVE', false],
    ['IN_REVIEW', 'MARK_DONE', true],
    ['REJECTED', 'MARK_DONE', true],
    ['APPROVED', 'MARK_DONE', false],
    ['APPROVED', 'ARCHIVE', false],
    ['ARCHIVED', 'UNARCHIVE', true],
    ['ARCHIVED', 'ARCHIVE', false],
    ['DONE', 'UNARCHIVE', false],
  ])('(%s, %s) → %s', (from, action, expected) => {
    expect(canTransition(from, action)).toBe(expected);
  });
});
