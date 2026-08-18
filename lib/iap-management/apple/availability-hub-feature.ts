/**
 * The hub-tracking feature tag for each bulk-availability mode — ONE map,
 * imported by both ends of the run.
 *
 * ⚠ WHY THIS IS A SHARED MODULE AND NOT TWO CONSTANTS.
 * A tracked run is opened by the CLIENT (`/hub-tracking/start`, fired on the
 * toolbar-button click) and closed by the SERVER (the bulk-availability route's
 * finalize). Both stamp a feature tag. Before this module existed they
 * disagreed for `set-territories`:
 *
 *   • server — `FEATURE_BY_ACTION` had all three, correctly
 *     (`iap-set-territories`)
 *   • client — `const HUB_FEATURE = mode === "set-all" ? "…set-availabilities"
 *     : "…remove-from-sales"` — a BINARY ternary, so the third mode was
 *     STARTed and CANCELLED as "iap-remove-from-sales"
 *
 * ⇒ a per-territory run opened under one identity and closed under another.
 * That is the status principle applied to tracking: a run's tag must describe
 * the operation that actually ran, never the branch a two-armed ternary
 * happened to fall into.
 *
 * This is the SIXTH member of the D1 binary-ternary family in this feature.
 * D1 converted five header strings (`title`, `subtitle`, `filterCopy`,
 * `emptyTitle`, `emptySub`) from binary ternaries to a `switch`; `HUB_FEATURE`
 * sat eleven lines above them and was missed because it is not user-visible —
 * it is only visible on the Hub, which no test rendered.
 *
 * ⚠ A `Record<BulkAvailabilityMode, string>` (not a function with a default)
 * so adding a fourth mode fails to COMPILE rather than silently inheriting
 * some other mode's tag. That is the whole point — do not add a fallback.
 */

/** The Manager-facing UI mode. Mirrors `BulkAvailabilityAction` in the
 *  orchestrator and `BulkMode` in the modal; kept structural rather than
 *  imported so this module stays free of client/server-only deps. */
export type AvailabilityHubMode = "set-all" | "remove" | "set-territories";

export const AVAILABILITY_HUB_FEATURE: Record<AvailabilityHubMode, string> = {
  "set-all": "iap-set-availabilities",
  remove: "iap-remove-from-sales",
  // Distinct tag: a per-territory write is not the same operation as
  // "publish everywhere", and the hub must not report it as one.
  "set-territories": "iap-set-territories",
};
