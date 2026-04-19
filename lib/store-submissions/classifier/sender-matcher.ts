/**
 * Step 1 — sender → platform.
 *
 * Matching is **case-insensitive** on trimmed email. Senders ingested by
 * Gmail sync (PR-8) are already extracted email-only, but we accept the
 * "Display Name <email@host>" format defensively so an input bug never
 * silently causes DROPPED. Inactive sender rows are skipped.
 *
 * See docs/store-submissions/03-email-rule-engine.md §3.1.
 */

import type { EmailInput, RulesSnapshot, SenderMatch } from './types';

const ANGLE_EMAIL_RE = /<([^>\s]+)>/;

function normalizeSenderEmail(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  // Extract email from display-name wrapper: "Apple <no-reply@apple.com>"
  const m = ANGLE_EMAIL_RE.exec(trimmed);
  return (m?.[1] ?? trimmed).trim().toLowerCase();
}

export function matchSender(
  email: EmailInput,
  rules: RulesSnapshot,
): SenderMatch | null {
  const needle = normalizeSenderEmail(email.sender);
  if (needle === '') return null;

  for (const s of rules.senders) {
    if (!s.active) continue;
    if (s.email.trim().toLowerCase() === needle) {
      return {
        platform_id: rules.platform_id,
        platform_key: rules.platform_key,
        sender_email: s.email,
      };
    }
  }
  return null;
}
