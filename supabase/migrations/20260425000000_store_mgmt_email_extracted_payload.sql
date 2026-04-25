-- PR-11.2 — Add extracted_payload column cho HTML structure persistence
--
-- Purpose: store ExtractedPayload từ html-extractor.ts independently
-- của classification_result. Enables reclassify feature without
-- re-parsing HTML, future queries by type/version.
--
-- Forward-only. Existing rows: NULL extracted_payload (backfill via
-- MANAGER reclassify action — PR-11.5+).

ALTER TABLE store_mgmt.email_messages
ADD COLUMN extracted_payload JSONB;

-- GIN index cho JSONB queries (filter by accepted_items[].type, etc.)
CREATE INDEX idx_store_mgmt_email_messages_extracted_payload_gin
ON store_mgmt.email_messages USING gin (extracted_payload);

-- Comment cho schema documentation
COMMENT ON COLUMN store_mgmt.email_messages.extracted_payload IS
'Structured payload extracted từ HTML body via html-extractor.ts.
 Shape: { accepted_items: AcceptedItem[] }. NULL cho legacy emails
 trước PR-11 ship — backfill via MANAGER reclassify action.';
