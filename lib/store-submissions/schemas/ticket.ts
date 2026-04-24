/**
 * Zod schemas for Store Management ticket queries + user actions.
 *
 * Mirrors store_mgmt schema in docs/store-submissions/01-data-model.md §2.3
 * (tickets, ticket_entries) and the endpoint contract in
 * docs/store-submissions/05-api-frontend.md §A.8 (pagination + filters).
 *
 * Shared client/server: used by Inbox UI filter forms, the ticket list
 * query builder, and the PR-10c Server Actions that dispatch user actions.
 *
 * **Coupling note — state + outcome + priority enums:**
 * The string unions here must stay in sync with:
 *   - lib/store-submissions/tickets/types.ts (TicketState / TicketRow)
 *   - store_mgmt.tickets CHECK constraints (migration 20260101100000)
 *   - store_mgmt.ticket_entries.entry_type CHECK constraint
 * Adding a value here requires a DB migration + a types.ts update.
 */

import { z } from 'zod';

import { platformKeySchema } from './app';

// -- Core enums -------------------------------------------------------------

/**
 * Ticket lifecycle states — 6 values. Terminal states (APPROVED/DONE/ARCHIVED)
 * pair with `closed_at IS NOT NULL` and `resolution_type IS NOT NULL`
 * per invariant #6. Open states are NEW/IN_REVIEW/REJECTED.
 */
export const ticketStateSchema = z.enum([
  'NEW',
  'IN_REVIEW',
  'REJECTED',
  'APPROVED',
  'DONE',
  'ARCHIVED',
]);
export type TicketState = z.infer<typeof ticketStateSchema>;

/**
 * Subset of states that are NOT terminal. Used by the Inbox "Open" tab
 * (NEW + IN_REVIEW + REJECTED = everything still needing action).
 */
export const openTicketStateSchema = z.enum(['NEW', 'IN_REVIEW', 'REJECTED']);
export type OpenTicketState = z.infer<typeof openTicketStateSchema>;

/** Latest email-derived outcome on a ticket. Null before any email lands. */
export const ticketOutcomeSchema = z.enum(['IN_REVIEW', 'REJECTED', 'APPROVED']);
export type TicketOutcome = z.infer<typeof ticketOutcomeSchema>;

export const ticketPrioritySchema = z.enum(['LOW', 'NORMAL', 'HIGH']);
export type TicketPriority = z.infer<typeof ticketPrioritySchema>;

/**
 * All 7 entry types per store_mgmt.ticket_entries.entry_type CHECK.
 * Timeline renderers switch on this. ASSIGNMENT / PRIORITY_CHANGE exist
 * in the schema but are deferred actions (post-MVP) — rendered if present
 * (e.g. from a historical row) but never created by PR-10c UI.
 */
export const ticketEntryTypeSchema = z.enum([
  'EMAIL',
  'COMMENT',
  'REJECT_REASON',
  'STATE_CHANGE',
  'PAYLOAD_ADDED',
  'ASSIGNMENT',
  'PRIORITY_CHANGE',
]);
export type TicketEntryType = z.infer<typeof ticketEntryTypeSchema>;

// -- List query -------------------------------------------------------------

/**
 * Tab bucket for the Inbox. Tracks whether a ticket is fully classified
 * or sitting in a triage bucket (app unknown / type unknown), per
 * invariant #8 grouping-key matrix.
 *
 *   classified          → app_id IS NOT NULL AND type_id IS NOT NULL
 *   unclassified_app    → app_id IS NULL
 *   unclassified_type   → app_id IS NOT NULL AND type_id IS NULL
 *
 * Omit the filter to mix everything (e.g. global search).
 */
export const ticketBucketSchema = z.enum([
  'classified',
  'unclassified_app',
  'unclassified_type',
]);
export type TicketBucket = z.infer<typeof ticketBucketSchema>;

export const ticketSortSchema = z.enum([
  'opened_at_desc',
  'updated_at_desc',
  'priority_desc',
]);
export type TicketSort = z.infer<typeof ticketSortSchema>;

/**
 * Cursor is an opaque string. Encode/decode lives in the query layer
 * (queries/tickets.ts) — schema only validates shape + length to avoid
 * obvious injection. Contents are base64-encoded JSON of the keyset
 * tuple matching `sort` (e.g. `{ opened_at, id }` for `opened_at_desc`).
 */
const cursorSchema = z.string().min(1).max(500);

/**
 * Date range for opened_at filter. ISO 8601 date strings (`YYYY-MM-DD`)
 * or full timestamps. Inclusive on both ends; `from` without `to` means
 * "since"; `to` without `from` means "up to".
 */
const isoDateSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), {
    message: 'Must be a valid ISO date or timestamp',
  });

/**
 * Filters accepted by listTickets. All fields optional. `state` accepts
 * either a single value or an array to match the Inbox tab design
 * (Open = [NEW, IN_REVIEW, REJECTED] passed as array).
 *
 * Per spec §A.8: cursor-based pagination for write-contention safety
 * (cron inserts tickets every 5min; offset pagination would shift under
 * concurrent inserts).
 */
export const ticketsQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),

  state: z.union([ticketStateSchema, z.array(ticketStateSchema).min(1)]).optional(),
  bucket: ticketBucketSchema.optional(),
  platform_key: platformKeySchema.optional(),
  app_id: z.string().uuid().optional(),
  type_id: z.string().uuid().optional(),
  priority: ticketPrioritySchema.optional(),
  assigned_to: z.string().uuid().optional(),

  /**
   * Fuzzy search across display_id + app name. Capped at 200 chars to
   * keep ILIKE patterns bounded.
   */
  search: z.string().trim().max(200).optional(),

  opened_from: isoDateSchema.optional(),
  opened_to: isoDateSchema.optional(),

  sort: ticketSortSchema.default('opened_at_desc'),
});
export type TicketsQuery = z.infer<typeof ticketsQuerySchema>;

// -- Ticket detail ----------------------------------------------------------

export const ticketIdParamSchema = z.object({
  ticket_id: z.string().uuid('Invalid ticket id'),
});
export type TicketIdParam = z.infer<typeof ticketIdParamSchema>;

// -- User actions (PR-10c stubs) --------------------------------------------

/**
 * Discriminated union of user actions available in PR-10c. Consumer is
 * `executeUserAction` (lib/store-submissions/tickets/user-actions.ts) —
 * shipping in PR-10c.1. Defined here so PR-10a+ UI can import stable
 * shapes without waiting for the engine expansion.
 *
 * **Deferred post-MVP** (not in this union):
 *   ASSIGN, SET_PRIORITY, SET_DUE_DATE, DELETE_COMMENT
 * See TODO.md PR-10+ entry.
 *
 * Authorization (per spec §7.2):
 *   - VIEWER: none
 *   - DEV:    all 7 below
 *   - MANAGER: all 7 below
 * (enforced in engine, not at schema — schema is shape-only)
 */
export const archiveActionSchema = z.object({
  type: z.literal('ARCHIVE'),
  ticket_id: z.string().uuid(),
});

export const followUpActionSchema = z.object({
  type: z.literal('FOLLOW_UP'),
  ticket_id: z.string().uuid(),
});

export const markDoneActionSchema = z.object({
  type: z.literal('MARK_DONE'),
  ticket_id: z.string().uuid(),
});

export const unarchiveActionSchema = z.object({
  type: z.literal('UNARCHIVE'),
  ticket_id: z.string().uuid(),
});

const commentBodySchema = z.string().trim().min(1, 'Comment cannot be empty').max(10_000);

export const addCommentActionSchema = z.object({
  type: z.literal('ADD_COMMENT'),
  ticket_id: z.string().uuid(),
  content: commentBodySchema,
});

export const editCommentActionSchema = z.object({
  type: z.literal('EDIT_COMMENT'),
  entry_id: z.string().uuid(),
  content: commentBodySchema,
});

export const addRejectReasonActionSchema = z.object({
  type: z.literal('ADD_REJECT_REASON'),
  ticket_id: z.string().uuid(),
  content: z.string().trim().min(1, 'Reject reason cannot be empty').max(10_000),
});

export const ticketActionSchema = z.discriminatedUnion('type', [
  archiveActionSchema,
  followUpActionSchema,
  markDoneActionSchema,
  unarchiveActionSchema,
  addCommentActionSchema,
  editCommentActionSchema,
  addRejectReasonActionSchema,
]);
export type TicketAction = z.infer<typeof ticketActionSchema>;
