// @vitest-environment jsdom

/**
 * Renderer tests for TicketEntriesTimeline.
 *
 * Coverage targets PR-10c.3.2 changes:
 *   - Trigger keyword fix (`'user' → 'user_action'` per spec §7.3)
 *   - New COMMENT + REJECT_REASON cards
 *   - currentUserId-gated pencil affordance
 *   - Dispatcher fallback for not-yet-implemented entry types
 *
 * EditCommentForm is mocked — it pulls server actions through dynamic
 * imports that don't tolerate the jsdom env, and these tests assert the
 * pencil toggle, not the edit submission. Form internals are exercised
 * server-side via the `edit_comment_tx` integration test in PR-10c.1.4.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { TicketEntryRow } from '@/lib/store-submissions/queries/tickets';
import type { TicketEntryType } from '@/lib/store-submissions/schemas/ticket';

// Mock factory must not contain JSX — vitest hoists `vi.mock` above imports,
// so the factory body runs before any React/JSX-runtime context. Returning
// `null` is sufficient: tests assert the pencil toggle, not the form body.
vi.mock('./EditCommentForm', () => ({
  EditCommentForm: () => null,
}));

import { TicketEntriesTimeline } from './TicketEntriesTimeline';

const CURRENT_USER = 'user-self';

function makeEntry(overrides: Partial<TicketEntryRow> = {}): TicketEntryRow {
  return {
    id: 'entry-1',
    ticket_id: 'ticket-1',
    entry_type: 'COMMENT',
    author_user_id: null,
    author_display_name: null,
    author_email: null,
    content: 'Test content',
    metadata: {},
    email_message_id: null,
    attachment_refs: [],
    edited_at: null,
    created_at: '2026-04-23T12:00:00Z',
    ...overrides,
  };
}

function renderTimeline(
  entries: TicketEntryRow[],
  currentUserId = CURRENT_USER,
) {
  return render(
    <TicketEntriesTimeline entries={entries} currentUserId={currentUserId} />,
  );
}

// -- Trigger keyword fix (spec §7.3) --------------------------------------

describe('TicketEntriesTimeline · STATE_CHANGE trigger keyword', () => {
  it('renders user_action trigger label (regression guard for 10c.3.2 fix)', () => {
    renderTimeline([
      makeEntry({
        entry_type: 'STATE_CHANGE',
        metadata: { from: 'NEW', to: 'ARCHIVED', trigger: 'user_action' },
      }),
    ]);
    expect(screen.getByText('Triggered by user action')).toBeInTheDocument();
  });

  it('renders email trigger label', () => {
    renderTimeline([
      makeEntry({
        entry_type: 'STATE_CHANGE',
        metadata: { from: 'NEW', to: 'IN_REVIEW', trigger: 'email' },
      }),
    ]);
    expect(screen.getByText('Triggered by incoming email')).toBeInTheDocument();
  });

  it('falls back to "Trigger unknown" for missing/invalid trigger', () => {
    renderTimeline([
      makeEntry({
        entry_type: 'STATE_CHANGE',
        metadata: { from: 'NEW', to: 'IN_REVIEW' },
      }),
    ]);
    expect(screen.getByText('Trigger unknown')).toBeInTheDocument();
  });
});

// -- CommentEntryCard ------------------------------------------------------

describe('TicketEntriesTimeline · CommentEntryCard', () => {
  it('renders content + author display name', () => {
    renderTimeline([
      makeEntry({
        entry_type: 'COMMENT',
        content: 'Looks good — approving.',
        author_user_id: 'user-other',
        author_display_name: 'Alice Reviewer',
      }),
    ]);
    expect(screen.getByText('Looks good — approving.')).toBeInTheDocument();
    expect(screen.getByText('Alice Reviewer')).toBeInTheDocument();
    expect(screen.getByText('Comment')).toBeInTheDocument();
  });

  it('shows edited indicator when edited_at is set, hides when null', () => {
    const { rerender } = renderTimeline([
      makeEntry({
        entry_type: 'COMMENT',
        content: 'Edited body',
        edited_at: '2026-04-23T13:00:00Z',
      }),
    ]);
    expect(screen.getByText(/^edited /)).toBeInTheDocument();

    rerender(
      <TicketEntriesTimeline
        entries={[
          makeEntry({
            entry_type: 'COMMENT',
            content: 'Edited body',
            edited_at: null,
          }),
        ]}
        currentUserId={CURRENT_USER}
      />,
    );
    expect(screen.queryByText(/^edited /)).not.toBeInTheDocument();
  });

  it('shows pencil affordance only on own comments', () => {
    const ownEntry = makeEntry({
      id: 'entry-own',
      entry_type: 'COMMENT',
      author_user_id: CURRENT_USER,
      content: 'My comment',
    });
    const otherEntry = makeEntry({
      id: 'entry-other',
      entry_type: 'COMMENT',
      author_user_id: 'user-other',
      content: 'Their comment',
    });

    renderTimeline([ownEntry, otherEntry]);

    const editButtons = screen.getAllByRole('button', { name: 'Edit comment' });
    expect(editButtons).toHaveLength(1);
  });
});

// -- RejectReasonEntryCard -------------------------------------------------

describe('TicketEntriesTimeline · RejectReasonEntryCard', () => {
  it('renders content with the "Rejection reason" label', () => {
    renderTimeline([
      makeEntry({
        entry_type: 'REJECT_REASON',
        content: 'Guideline 2.3.10 — Metadata: screenshots include unreleased features.',
        author_user_id: 'user-mgr',
        author_display_name: 'Manager Mike',
        metadata: { source: 'manual_paste' },
      }),
    ]);
    expect(screen.getByText('Rejection reason')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Guideline 2.3.10 — Metadata: screenshots include unreleased features.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Manager Mike')).toBeInTheDocument();
  });

  it('shows "Pasted manually" chip iff metadata.source === manual_paste', () => {
    const { rerender } = renderTimeline([
      makeEntry({
        entry_type: 'REJECT_REASON',
        content: 'Reason A',
        metadata: { source: 'manual_paste' },
      }),
    ]);
    expect(screen.getByText('Pasted manually')).toBeInTheDocument();

    rerender(
      <TicketEntriesTimeline
        entries={[
          makeEntry({
            entry_type: 'REJECT_REASON',
            content: 'Reason B',
            metadata: {},
          }),
        ]}
        currentUserId={CURRENT_USER}
      />,
    );
    expect(screen.queryByText('Pasted manually')).not.toBeInTheDocument();
  });
});

// -- Dispatcher fallback ---------------------------------------------------

describe('TicketEntriesTimeline · dispatcher fallback', () => {
  // ASSIGNMENT + PRIORITY_CHANGE are in TicketEntryType but no dedicated
  // renderer ships in PR-10c — they should fall through to UnknownEntryCard
  // so the timeline renders something (rather than throwing) until those
  // entry types ship their own cards post-MVP.
  it.each([
    ['ASSIGNMENT' as TicketEntryType],
    ['PRIORITY_CHANGE' as TicketEntryType],
  ])('routes %s to UnknownEntryCard fallback', (entryType) => {
    renderTimeline([makeEntry({ entry_type: entryType, content: null })]);
    // UnknownEntryCard echoes the entry_type in two places (header label +
    // <code> in the body) — assert via getAllByText to tolerate that, plus
    // the fallback message which is unique.
    expect(screen.getAllByText(entryType).length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText(/No renderer yet for entry type/),
    ).toBeInTheDocument();
  });
});
