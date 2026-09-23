"use client";

/**
 * Close-on-click-outside, as one hook.
 *
 * ⚠ THIS EXISTS BECAUSE THERE WERE ALREADY THREE COPIES. The same eight lines
 * — `mousedown` listener, `ref.current.contains(e.target)`, remove on unmount —
 * are inlined in `components/layout/AccountSwitcher.tsx`,
 * `components/cpp/CppList.tsx` and
 * `components/google-iap-management/layout/GoogleAccountSwitcher.tsx`.
 * `[BULKIMPORT-loc-step]` C3 needed a fourth for the Localization step's detail
 * popover; writing it would have made four. CLAUDE.md meta-rule P1.
 *
 * ⚠ THE THREE EXISTING COPIES ARE DELIBERATELY NOT MIGRATED HERE.
 * They sit in three different modules — a SHARED layout file (`AccountSwitcher`,
 * rendered by `TopNav` for every tool), the CPP module, and the Google module.
 * CLAUDE.md forbids touching shared files without cross-module consideration
 * and requires a separate census before touching Google. Rewriting all three
 * inside an Apple-IAP arc would put three modules' regression risk on a chunk
 * that is about a wizard step. Migrating them is tracked separately as
 * `[CLICKOUTSIDE-3-copies]`; this hook is what they migrate TO.
 */
import { useEffect, type RefObject } from "react";

export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onOutside: () => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    function handle(e: MouseEvent) {
      const el = ref.current;
      if (el && !el.contains(e.target as Node)) onOutside();
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [ref, onOutside, enabled]);
}
