/**
 * Pagination cursor-stack unit tests — MV26 A-K + edge cases.
 *
 * Mirrors the PR-13.3 `empty-message.test.ts` pure-helper pattern: every
 * locked Manager UAT scenario gets one direct test so the harness
 * catches regressions in the URL-shape contract that the React render
 * tree can't easily assert.
 */

import { describe, expect, it } from 'vitest';

import {
  canGoBackFrom,
  computeBackParams,
  computeNextParams,
  parsePrevStack,
} from './pagination-stack';

const C1 = 'cursor-page2';
const C2 = 'cursor-page3';
const C3 = 'cursor-page4';

describe('parsePrevStack', () => {
  it('returns empty array for null / undefined / empty', () => {
    expect(parsePrevStack(null)).toEqual([]);
    expect(parsePrevStack(undefined)).toEqual([]);
    expect(parsePrevStack('')).toEqual([]);
  });

  it('splits single cursor', () => {
    expect(parsePrevStack(C1)).toEqual([C1]);
  });

  it('splits multi-cursor stack preserving order', () => {
    expect(parsePrevStack(`${C1},${C2}`)).toEqual([C1, C2]);
  });

  it('filters empty segments (malformed param defense)', () => {
    expect(parsePrevStack(`${C1},,${C2}`)).toEqual([C1, C2]);
    expect(parsePrevStack(',')).toEqual([]);
    expect(parsePrevStack(`,${C1},`)).toEqual([C1]);
  });
});

describe('canGoBackFrom', () => {
  it('false on page 1 (no cursor, no stack) — MV26.A', () => {
    expect(canGoBackFrom({ currentCursor: null, prevStack: [] })).toBe(false);
    expect(canGoBackFrom({ currentCursor: undefined, prevStack: [] })).toBe(
      false,
    );
    expect(canGoBackFrom({ currentCursor: '', prevStack: [] })).toBe(false);
  });

  it('true on page 2 (cursor set, stack still empty) — MV26.C', () => {
    expect(canGoBackFrom({ currentCursor: C1, prevStack: [] })).toBe(true);
  });

  it('true on page 3+ (cursor + non-empty stack)', () => {
    expect(canGoBackFrom({ currentCursor: C2, prevStack: [C1] })).toBe(true);
  });

  it('true on URL-paste with cursor + non-empty stack — MV26.I', () => {
    expect(canGoBackFrom({ currentCursor: C2, prevStack: [C1] })).toBe(true);
  });
});

describe('computeNextParams', () => {
  it('returns null when nextCursor is missing — MV26.F last page', () => {
    expect(
      computeNextParams({
        currentCursor: C2,
        prevStack: [C1],
        nextCursor: null,
      }),
    ).toBeNull();
    expect(
      computeNextParams({
        currentCursor: C2,
        prevStack: [C1],
        nextCursor: undefined,
      }),
    ).toBeNull();
    expect(
      computeNextParams({
        currentCursor: C2,
        prevStack: [C1],
        nextCursor: '',
      }),
    ).toBeNull();
  });

  it('page 1 → page 2: sets cursor only, no prev push — MV26.B', () => {
    expect(
      computeNextParams({
        currentCursor: null,
        prevStack: [],
        nextCursor: C1,
      }),
    ).toEqual({ cursor: C1 });
  });

  it('page 1 → page 2 with undefined currentCursor: no push', () => {
    expect(
      computeNextParams({
        currentCursor: undefined,
        prevStack: [],
        nextCursor: C1,
      }),
    ).toEqual({ cursor: C1 });
  });

  it('page 2 → page 3: pushes current cursor, sets prev — MV26.E', () => {
    expect(
      computeNextParams({
        currentCursor: C1,
        prevStack: [],
        nextCursor: C2,
      }),
    ).toEqual({ cursor: C2, prev: C1 });
  });

  it('page 3 → page 4: grows stack', () => {
    expect(
      computeNextParams({
        currentCursor: C2,
        prevStack: [C1],
        nextCursor: C3,
      }),
    ).toEqual({ cursor: C3, prev: `${C1},${C2}` });
  });

  it('empty currentCursor with existing stack: preserves stack, no push', () => {
    // Defensive: corrupt URL state — cursor cleared but stack
    // somehow non-empty. Don't push the empty cursor; preserve
    // history so Back still works.
    expect(
      computeNextParams({
        currentCursor: '',
        prevStack: [C1],
        nextCursor: C2,
      }),
    ).toEqual({ cursor: C2, prev: C1 });
  });
});

describe('computeBackParams', () => {
  it('page 2 → page 1: empty pop → no cursor, no prev (clean URL) — MV26.D', () => {
    expect(computeBackParams({ prevStack: [] })).toEqual({});
  });

  it('page 3 → page 2: pops cursor, clears prev — MV26.I', () => {
    expect(computeBackParams({ prevStack: [C1] })).toEqual({ cursor: C1 });
  });

  it('page 4 → page 3: pops cursor, residual stack joined', () => {
    expect(computeBackParams({ prevStack: [C1, C2] })).toEqual({
      cursor: C2,
      prev: C1,
    });
  });

  it('page 5 → page 4: pops top of multi-entry stack', () => {
    expect(computeBackParams({ prevStack: [C1, C2, C3] })).toEqual({
      cursor: C3,
      prev: `${C1},${C2}`,
    });
  });
});

describe('Forward + Back round-trip (Manager UAT MV26 walk-through)', () => {
  // Simulate Manager's exact MV26 click sequence to catch any
  // asymmetry between the push and pop semantics.

  it('Next from page 1 → Back → page 1 (clean) — MV26.B + MV26.D', () => {
    const afterNext = computeNextParams({
      currentCursor: null,
      prevStack: [],
      nextCursor: C1,
    });
    expect(afterNext).toEqual({ cursor: C1 });

    // Now URL is ?cursor=C1, stack still [] (no push happened).
    const backFromPage2 = computeBackParams({ prevStack: [] });
    expect(backFromPage2).toEqual({});
  });

  it('Next twice then Back twice → page 1 clean — MV26.E + double Back', () => {
    // Page 1 → 2
    const a = computeNextParams({
      currentCursor: null,
      prevStack: [],
      nextCursor: C1,
    });
    expect(a).toEqual({ cursor: C1 });

    // Page 2 → 3 (push C1)
    const b = computeNextParams({
      currentCursor: C1,
      prevStack: [],
      nextCursor: C2,
    });
    expect(b).toEqual({ cursor: C2, prev: C1 });

    // Page 3 → 2 (pop C1, stack now empty)
    const back1 = computeBackParams({ prevStack: [C1] });
    expect(back1).toEqual({ cursor: C1 });

    // Page 2 → 1 (empty pop, clean URL)
    const back2 = computeBackParams({ prevStack: [] });
    expect(back2).toEqual({});
  });

  it('URL-paste recovery (?cursor=C2&prev=C1) → Back lands on page 2 — MV26.I', () => {
    const stack = parsePrevStack(C1);
    expect(stack).toEqual([C1]);
    expect(canGoBackFrom({ currentCursor: C2, prevStack: stack })).toBe(true);

    const back = computeBackParams({ prevStack: stack });
    expect(back).toEqual({ cursor: C1 });
  });

  it('Deep stack: Next 3× then Back 3× returns to page 1', () => {
    // Page 1 → 2 (no push)
    let stack: string[] = [];
    let cursor: string | undefined;
    let next = computeNextParams({
      currentCursor: cursor,
      prevStack: stack,
      nextCursor: C1,
    });
    expect(next).toEqual({ cursor: C1 });
    cursor = next?.cursor;
    stack = parsePrevStack(next?.prev ?? null);

    // Page 2 → 3 (push C1)
    next = computeNextParams({
      currentCursor: cursor,
      prevStack: stack,
      nextCursor: C2,
    });
    expect(next).toEqual({ cursor: C2, prev: C1 });
    cursor = next?.cursor;
    stack = parsePrevStack(next?.prev ?? null);

    // Page 3 → 4 (push C2)
    next = computeNextParams({
      currentCursor: cursor,
      prevStack: stack,
      nextCursor: C3,
    });
    expect(next).toEqual({ cursor: C3, prev: `${C1},${C2}` });
    cursor = next?.cursor;
    stack = parsePrevStack(next?.prev ?? null);

    // Now Back 3×
    let back = computeBackParams({ prevStack: stack });
    expect(back).toEqual({ cursor: C2, prev: C1 });
    cursor = back.cursor;
    stack = parsePrevStack(back.prev ?? null);

    back = computeBackParams({ prevStack: stack });
    expect(back).toEqual({ cursor: C1 });
    cursor = back.cursor;
    stack = parsePrevStack(back.prev ?? null);

    back = computeBackParams({ prevStack: stack });
    expect(back).toEqual({});
  });
});
