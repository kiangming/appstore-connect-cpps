/**
 * Pagination cursor-stack URL math for the Inbox list (PR-Inbox.PaginationBack).
 *
 * Pure helpers extracted from `InboxClient` so the Prev/Next cursor-stack
 * logic is unit-testable without mounting the React tree. Mirrors the
 * PR-13.3 `empty-message.ts` extraction pattern: clean separation between
 * UI scaffolding (event handlers, navigate) and the URL-shape decisions
 * those handlers commit to the URL.
 *
 * **Pattern A** (Manager LOCKED): the back-history is encoded as a
 * comma-separated stack in `?prev=…` alongside the current `?cursor=…`.
 * The server schema only forwards keys it knows (`cursor` is one,
 * `prev` is NOT) — so `prev` is a purely client-side affordance with
 * zero server contract changes.
 *
 * **Page-number-less indicator** (Option Z): the stack length is the
 * only "where am I" signal we keep. We don't surface "Page N" because
 * keyset pagination doesn't have an offset semantic to anchor it on
 * (cursors point at boundary rows, not page indices).
 *
 * **Edge case matrix** (Manager UAT MV26 A-K, frozen 2026-05-14):
 *
 *   - MV26.A Page 1 → Back hidden, Next visible
 *   - MV26.B Click Next page 1 → ?cursor=C1 (no prev push — page 1
 *     has no current cursor to stack)
 *   - MV26.C Page 2 → Back + Next both visible
 *   - MV26.D Click Back from page 2 → clean URL (cursor cleared,
 *     stack already empty)
 *   - MV26.E Click Next twice → ?cursor=C2&prev=C1 (page 2's cursor
 *     pushed)
 *   - MV26.F Last page → Next hidden (has_more=false)
 *   - MV26.G/H Filter/tab change → cursor + prev dropped naturally by
 *     `baseParams` rebuilding from scalarKeys whitelist (handled by
 *     `InboxClient.baseParams`, not this module)
 *   - MV26.I URL paste ?cursor=C2&prev=C1 → Back navigates to page 2
 *     (cursor=C1, prev cleared)
 *   - MV26.J Browser back/forward — out-of-scope, uses `router.replace`
 *     semantics from `InboxClient.navigate`
 *   - MV26.K Empty result state — pagination footer collapses to count
 *     only (handled by render-side conditional, not this module)
 *
 * **Pure.** No DOM, no router, no logging. All inputs flow in as args;
 * outputs are the URL-param mutations the caller applies to a fresh
 * URLSearchParams (typically the one returned from `baseParams`).
 */

/**
 * URL-param shape returned by `computeNextParams` / `computeBackParams`.
 *
 *   - `cursor` undefined → drop the cursor key entirely (return to page 1)
 *   - `prev` undefined → drop the prev key entirely (stack emptied)
 *
 * Caller merges with the base URLSearchParams via `.set` / not-setting,
 * preserving unrelated filter params untouched.
 */
export interface PaginationParams {
  cursor?: string;
  prev?: string;
}

/**
 * Parse a `?prev=` URL value into the cursor stack. Tolerates `null` /
 * `undefined` / empty-string for callers reading directly from
 * `URLSearchParams.get`. Empty segments (`",,foo"`) filter out so a
 * malformed param doesn't corrupt the stack into ghost cursors.
 */
export function parsePrevStack(
  rawPrev: string | null | undefined,
): string[] {
  if (!rawPrev) return [];
  return rawPrev.split(',').filter(Boolean);
}

/**
 * "Where am I?" — the only signal we surface alongside Prev/Next. True
 * when EITHER the stack has entries OR we have a current cursor (means
 * we're on page 2+ even with stack empty — the page 1 → 2 transition
 * doesn't push, so page 2 has cursor without stack).
 */
export function canGoBackFrom(args: {
  currentCursor: string | null | undefined;
  prevStack: string[];
}): boolean {
  return args.prevStack.length > 0 || Boolean(args.currentCursor);
}

/**
 * Compute the URL-param mutations for clicking Next.
 *
 * Stack-push rule: push `currentCursor` only if defined. Page 1 → page 2
 * has no `currentCursor` to push, so the stack stays empty. Page N → N+1
 * (N>1) pushes the current page's cursor, growing the stack so Back can
 * later walk back through history.
 *
 * Returns `null` when there's nothing to navigate to (last page). The
 * caller's render conditional should hide the Next button in that case,
 * but defense-in-depth: a programmatic call still no-ops cleanly.
 */
export function computeNextParams(args: {
  currentCursor: string | null | undefined;
  prevStack: string[];
  nextCursor: string | null | undefined;
}): PaginationParams | null {
  if (!args.nextCursor) return null;
  const newStack = args.currentCursor
    ? [...args.prevStack, args.currentCursor]
    : args.prevStack;
  return newStack.length > 0
    ? { cursor: args.nextCursor, prev: newStack.join(',') }
    : { cursor: args.nextCursor };
}

/**
 * Compute the URL-param mutations for clicking Back.
 *
 * Stack-pop rule: pop the top entry; the popped value becomes the new
 * `cursor`. If the popped value is undefined (stack was empty), the new
 * URL has no cursor — we're returning to page 1 with a clean URL. If
 * the popped value is defined and the residual stack is non-empty, the
 * residual is joined as the new `prev`.
 *
 * Returns `{}` for the page-2 → page-1 transition (empty stack pop):
 * caller should not set any cursor/prev params, letting baseParams
 * produce the clean page-1 URL.
 */
export function computeBackParams(args: {
  prevStack: string[];
}): PaginationParams {
  const newCursor = args.prevStack[args.prevStack.length - 1];
  if (!newCursor) return {};
  const newStack = args.prevStack.slice(0, -1);
  return newStack.length > 0
    ? { cursor: newCursor, prev: newStack.join(',') }
    : { cursor: newCursor };
}
