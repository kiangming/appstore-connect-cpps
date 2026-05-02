-- ============================================================
-- Migration: Store Management — PR-16b auto-completed query RPCs
--
-- Two SQL functions backing the PR-16b banner + dedicated
-- /auto-completed view:
--
--   1. count_auto_completed_tickets(p_days)
--        Returns BIGINT count of state='DONE' tickets closed within the
--        last p_days whose latest STATE_CHANGE entry is system-origin
--        auto_mark_done. Drives the MANAGER-only Inbox banner display.
--
--   2. list_auto_completed_tickets(p_days, p_limit)
--        Returns the same set joined với apps / types / platforms / users
--        in TicketListRow-compatible shape. Backs the /auto-completed
--        dedicated view's TicketListTable rendering. Sorted by closed_at
--        DESC.
--
-- "Latest STATE_CHANGE = system + auto_mark_done%" filter (Q1.E + Q2.D
-- detection mechanism):
--   - Distinguishes auto-DONEd tickets từ Manager-marked-DONE tickets
--   - Excludes auto-DONE tickets that Manager manually re-touched
--     (latest STATE_CHANGE actor=manager_uuid → not eligible)
--   - Uses `idx_store_mgmt_ticket_entries_ticket_created`
--     (ticket_id, created_at DESC) cho O(log N) per-ticket lookup
--
-- Performance: 7-day window + small Manager opt-in pattern set keep row
-- counts <50/week trong production. Sub-100ms even at full scale.
--
-- Related: PR-16a auto-DONE branch trong find_or_create_ticket_tx
-- writes the STATE_CHANGE entries that this query filters on.
-- PR-16b auto-reopen branch (16b.3 migration) adds entries with
-- reason='auto_reopen_rejected' which DON'T match this filter — once
-- a ticket is auto-reopened it leaves DONE state anyway.
-- ============================================================

-- -----------------------------------------------------------------
-- count_auto_completed_tickets — banner count probe
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION store_mgmt.count_auto_completed_tickets(
  p_days INT DEFAULT 7
) RETURNS BIGINT AS $$
  SELECT COUNT(*)::BIGINT
    FROM store_mgmt.tickets t
   WHERE t.state = 'DONE'
     AND t.closed_at > NOW() - (p_days || ' days')::INTERVAL
     AND EXISTS (
       SELECT 1 FROM (
         SELECT e.metadata
           FROM store_mgmt.ticket_entries e
          WHERE e.ticket_id = t.id
            AND e.entry_type = 'STATE_CHANGE'
          ORDER BY e.created_at DESC
          LIMIT 1
       ) latest
       WHERE latest.metadata->>'actor' = 'system'
         AND latest.metadata->>'reason' LIKE 'auto_mark_done%'
     );
$$ LANGUAGE sql SECURITY INVOKER STABLE;

COMMENT ON FUNCTION store_mgmt.count_auto_completed_tickets(INT) IS
  'PR-16b banner count probe. Returns count of DONE tickets in last p_days whose latest STATE_CHANGE is system auto_mark_done. Used by MANAGER-only Inbox banner.';

GRANT EXECUTE ON FUNCTION store_mgmt.count_auto_completed_tickets(INT)
  TO service_role;

-- -----------------------------------------------------------------
-- list_auto_completed_tickets — /auto-completed view rows
-- -----------------------------------------------------------------
-- Returns TicketListRow-compatible shape via inline JOINs. Mirrors
-- the join fan-out trong listTickets() (queries/tickets.ts) so the
-- caller can pass result directly to TicketListTable without a
-- second-pass enrichment in TS.
--
-- entry_count + type_payload_count are computed server-side per row;
-- skipping the listTickets() ticket_ids→entry_count Map roundtrip.
CREATE OR REPLACE FUNCTION store_mgmt.list_auto_completed_tickets(
  p_days  INT DEFAULT 7,
  p_limit INT DEFAULT 100
) RETURNS TABLE (
  id                       UUID,
  display_id               TEXT,
  app_id                   UUID,
  app_name                 TEXT,
  app_slug                 TEXT,
  type_id                  UUID,
  type_name                TEXT,
  type_slug                TEXT,
  platform_id              UUID,
  platform_key             TEXT,
  platform_display_name    TEXT,
  state                    TEXT,
  latest_outcome           TEXT,
  priority                 TEXT,
  opened_at                TIMESTAMPTZ,
  updated_at               TIMESTAMPTZ,
  closed_at                TIMESTAMPTZ,
  due_date                 DATE,
  assigned_to              UUID,
  assigned_to_display_name TEXT,
  assigned_to_email        TEXT,
  entry_count              BIGINT,
  submission_ids           TEXT[],
  type_payload_count       BIGINT
) AS $$
  SELECT
    t.id, t.display_id,
    t.app_id, a.name AS app_name, a.slug AS app_slug,
    t.type_id, ty.name AS type_name, ty.slug AS type_slug,
    t.platform_id, p.key AS platform_key, p.display_name AS platform_display_name,
    t.state, t.latest_outcome, t.priority,
    t.opened_at, t.updated_at, t.closed_at, t.due_date,
    t.assigned_to, u.display_name AS assigned_to_display_name, u.email AS assigned_to_email,
    (SELECT COUNT(*)::BIGINT
       FROM store_mgmt.ticket_entries e
      WHERE e.ticket_id = t.id) AS entry_count,
    t.submission_ids,
    jsonb_array_length(t.type_payloads)::BIGINT AS type_payload_count
  FROM store_mgmt.tickets t
  LEFT JOIN store_mgmt.apps      a  ON a.id = t.app_id
  LEFT JOIN store_mgmt.types     ty ON ty.id = t.type_id
  JOIN      store_mgmt.platforms p  ON p.id = t.platform_id
  LEFT JOIN store_mgmt.users     u  ON u.id = t.assigned_to
  WHERE t.state = 'DONE'
    AND t.closed_at > NOW() - (p_days || ' days')::INTERVAL
    AND EXISTS (
      SELECT 1 FROM (
        SELECT e.metadata
          FROM store_mgmt.ticket_entries e
         WHERE e.ticket_id = t.id
           AND e.entry_type = 'STATE_CHANGE'
         ORDER BY e.created_at DESC
         LIMIT 1
      ) latest
      WHERE latest.metadata->>'actor' = 'system'
        AND latest.metadata->>'reason' LIKE 'auto_mark_done%'
    )
  ORDER BY t.closed_at DESC
  LIMIT p_limit;
$$ LANGUAGE sql SECURITY INVOKER STABLE;

COMMENT ON FUNCTION store_mgmt.list_auto_completed_tickets(INT, INT) IS
  'PR-16b /auto-completed view list. Returns TicketListRow-compatible joined shape sorted by closed_at DESC. p_days defaults to 7, p_limit defaults to 100.';

GRANT EXECUTE ON FUNCTION store_mgmt.list_auto_completed_tickets(INT, INT)
  TO service_role;

-- ============================================================
-- END — 20260503000000_store_mgmt_pr16_auto_completed_query
-- ============================================================
