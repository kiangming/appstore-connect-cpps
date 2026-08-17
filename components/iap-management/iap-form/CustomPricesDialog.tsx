"use client";

/**
 * Per-territory Custom Prices dialog.
 *
 * Design: docs/iap-management/design-apple-custom-territory-prices.md §B-§F.
 * Visual target: docs/iap-management/design/apple-custom-territory-prices-mockup.html
 *
 * Load-bearing behaviours, each traceable to a gate:
 *   G3  the ~175-row table renders with ZERO price-point requests; a territory's
 *       options are fetched only when its picker opens, then cached in this
 *       component's state for the dialog's lifetime (no server cache — P6).
 *   G4  existing manual prices come from the schedule read, already filtered to
 *       startDate === null server-side, so a scheduled future change can never
 *       be read as the current price.
 *   G5  provenance per row, with the two weak claims labelled honestly.
 *   J-6 every "on Apple now" row states that it will be WIPED by the next push,
 *       and offers the import that makes it survive — bulk and per-row.
 *   J-1 no donor synced IAP ⇒ the picker is disabled with the reason shown, and
 *       there is no CSV fallback.
 *   §C  revertibility: one territory, and all. Clearing DELETES; no sentinels.
 *   §E  the base-territory row is read-only.
 *
 * Submit blocking is SC3. This dialog renders the stale state and offers the two
 * resolutions; it does not gate the Apple write.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { X, AlertTriangle, Download } from "lucide-react";
import { TerritoryPickerShell } from "@/components/iap-management/territory/TerritoryPickerShell";
import {
  assembleBaselineRows,
  baselineCounts,
  importableManualRows,
  manualRowToCustomEntry,
  matchesBaselineQuery,
  provenanceLabel,
  EXISTING_MANUAL_WARNING,
  NO_DONOR_REASON,
  type BaselineRow,
} from "@/lib/iap-management/custom-prices/baseline";
import {
  clearAllCustomPrices,
  clearCustomPrice,
  isCustomBaselineStale,
  setCustomPrice,
  toCustomPriceEntries,
  toCustomPriceSet,
  type CustomPriceBaseline,
  type CustomPriceEntry,
} from "@/lib/iap-management/custom-prices/model";
import type { CustomPriceBaselineResponse } from "@/app/api/iap-management/apps/[appId]/iaps/[iapId]/custom-prices/baseline/route";
import type { PricePointOptionsResponse } from "@/app/api/iap-management/apps/[appId]/iaps/[iapId]/price-points/route";

export interface CustomPricesDialogProps {
  open: boolean;
  onClose: () => void;
  appAppleId: string;
  iapId: string;
  /** Current form values — the fingerprint the edited set is measured against. */
  currentBaseline: CustomPriceBaseline | null;
  /** The fingerprint the STORED set was built against (null = no customs). */
  storedBaseline: CustomPriceBaseline | null;
  /** Persisted set, so the dialog opens showing real values (§F: never opaque). */
  initialEntries: readonly CustomPriceEntry[];
  /** Called after a successful save so the form can refresh its summary. */
  onSaved: (entries: CustomPriceEntry[], baseline: CustomPriceBaseline | null) => void;
}

/* Module-level so their identity is stable across renders — the shell memoises
   the filter on these, and inline arrows would re-filter every render. */
const rowCode = (row: BaselineRow) => row.territory_code;
/** "Only customised" — the base row is exempt (§E: it is always shown). */
const notCustomisedFilter = (row: BaselineRow) =>
  row.custom_price !== null || row.is_base;

type PriceOptionState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; prices: number[] }
  | { status: "error"; message: string }
  | { status: "no-donor" };

export function CustomPricesDialog({
  open,
  onClose,
  appAppleId,
  iapId,
  currentBaseline,
  storedBaseline,
  initialEntries,
  onSaved,
}: CustomPricesDialogProps) {
  const [baseline, setBaseline] = useState<CustomPriceBaselineResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /**
   * PRESENTATION STATE, kept deliberately separate from the persisted set (SC1's
   * dead-affordance rule). Edits live here until Save; Cancel discards them
   * wholesale. A territory is a key or it is absent — there is no "cleared"
   * value anywhere in this map.
   */
  const [draft, setDraft] = useState(() => toCustomPriceSet(initialEntries));
  const [onlyCustomised, setOnlyCustomised] = useState(false);
  /**
   * Bumped by the open-reset effect below. The shell owns the search box and
   * the continent chip, so this is how they get cleared — it reproduces the
   * previous inline `setQuery("")` / `setContinent("ALL")` exactly, INCLUDING
   * the `initialEntries` dependency (a new array identity from the parent
   * clears the box mid-session). That is pre-existing behaviour, carried over
   * deliberately rather than quietly changed inside a refactor.
   */
  const [filterEpoch, setFilterEpoch] = useState(0);
  const [options, setOptions] = useState<Record<string, PriceOptionState>>({});
  /** Territories whose stored custom is no longer in Apple's list (§I.3). Only
   *  populated for territories whose options were actually fetched — we never
   *  claim a clean bill of health for a row we have not checked. */
  const [unavailable, setUnavailable] = useState<string[]>([]);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Reset presentation state on each open so a cancelled session cannot leak
  // into the next one.
  useEffect(() => {
    if (!open) return;
    setDraft(toCustomPriceSet(initialEntries));
    setOnlyCustomised(false);
    setUnavailable([]);
    setFilterEpoch((e) => e + 1);
  }, [open, initialEntries]);

  // ── Dialog-open baseline load: ONE request, no price points (G3) ───────────
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const params = new URLSearchParams();
    if (currentBaseline?.tier_id) params.set("tier_id", currentBaseline.tier_id);
    if (currentBaseline?.pricing_source) {
      params.set("pricing_source", currentBaseline.pricing_source);
    }
    fetch(
      `/api/iap-management/apps/${appAppleId}/iaps/${iapId}/custom-prices/baseline?${params}`,
    )
      .then(async (res) => {
        const data = (await res.json()) as
          | CustomPriceBaselineResponse
          | { error: string };
        if (cancelled) return;
        if (!res.ok || "error" in data) {
          setLoadError("error" in data ? data.error : `Load failed (${res.status})`);
          return;
        }
        setBaseline(data);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Network error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, appAppleId, iapId, currentBaseline?.tier_id, currentBaseline?.pricing_source]);

  const rows = useMemo<BaselineRow[]>(() => {
    if (!baseline) return [];
    return assembleBaselineRows({
      territories: baseline.territories,
      baseTerritory: baseline.base_territory,
      basePrice: baseline.base_price,
      templateEntries: baseline.template_entries,
      existingManual: baseline.existing_manual,
      customPrices: toCustomPriceEntries(draft),
      unavailableCustomTerritories: unavailable,
    });
  }, [baseline, draft, unavailable]);

  const counts = useMemo(() => baselineCounts(rows), [rows]);
  const importable = useMemo(() => importableManualRows(rows), [rows]);

  const stale = isCustomBaselineStale(currentBaseline, storedBaseline);
  const donorAvailable = baseline?.donor_available ?? false;

  // ── Lazy per-territory price points (G3) ─────────────────────────────────
  const loadOptions = useCallback(
    async (territory: string) => {
      if (optionsRef.current[territory]?.status === "ready") return;
      if (optionsRef.current[territory]?.status === "loading") return;
      setOptions((prev) => ({ ...prev, [territory]: { status: "loading" } }));
      try {
        const res = await fetch(
          `/api/iap-management/apps/${appAppleId}/iaps/${iapId}/price-points?territory=${territory}`,
        );
        const data = (await res.json()) as
          | PricePointOptionsResponse
          | { error: string; reason?: string };
        if (!res.ok || "error" in data) {
          const noDonor = "reason" in data && data.reason === "no-donor";
          setOptions((prev) => ({
            ...prev,
            [territory]: noDonor
              ? { status: "no-donor" }
              : { status: "error", message: "error" in data ? data.error : "failed" },
          }));
          return;
        }
        setOptions((prev) => ({
          ...prev,
          [territory]: { status: "ready", prices: data.prices },
        }));
        // §I.3 — re-validate the stored custom against Apple's CURRENT list. The
        // pick→submit window for a custom is days, not one orchestration, so a
        // point can be withdrawn in between.
        const existing = draft.get(territory);
        if (existing && !data.prices.includes(existing.customer_price)) {
          setUnavailable((prev) =>
            prev.includes(territory) ? prev : [...prev, territory],
          );
        } else {
          setUnavailable((prev) => prev.filter((t) => t !== territory));
        }
      } catch (err) {
        setOptions((prev) => ({
          ...prev,
          [territory]: {
            status: "error",
            message: err instanceof Error ? err.message : "Network error",
          },
        }));
      }
    },
    [appAppleId, iapId, draft],
  );

  // ── Edits ────────────────────────────────────────────────────────────────
  function handlePick(row: BaselineRow, raw: string) {
    if (raw === "") {
      // The placeholder IS the per-row revert. Deletes the key — never a
      // sentinel, so a reverted territory is indistinguishable from one that
      // never had a custom.
      setDraft((prev) => clearCustomPrice(prev, row.territory_code));
      setUnavailable((prev) => prev.filter((t) => t !== row.territory_code));
      return;
    }
    const price = Number(raw);
    if (!Number.isFinite(price)) return;
    setDraft((prev) =>
      setCustomPrice(prev, {
        territory_code: row.territory_code,
        customer_price: price,
        currency_code: row.currency_code ?? "",
      }),
    );
    setUnavailable((prev) => prev.filter((t) => t !== row.territory_code));
  }

  function handleRevert(row: BaselineRow) {
    setDraft((prev) => clearCustomPrice(prev, row.territory_code));
    setUnavailable((prev) => prev.filter((t) => t !== row.territory_code));
  }

  function handleClearAll() {
    if (counts.customised === 0) return;
    if (
      !confirm(
        `Clear ${counts.customised} custom price${counts.customised === 1 ? "" : "s"}? ` +
          "Those territories revert to template/auto. The values are written to the audit log.",
      )
    ) {
      return;
    }
    setDraft(clearAllCustomPrices());
    setUnavailable([]);
  }

  /** J-6 per-row: adopt Apple's current price so it survives the replace-all. */
  function handleImportRow(row: BaselineRow) {
    const entry = manualRowToCustomEntry(row);
    if (!entry) return;
    setDraft((prev) => setCustomPrice(prev, entry));
  }

  /** J-6 bulk: adopt every effective-now manual price not already customised. */
  function handleImportAll() {
    const entries = importable
      .map(manualRowToCustomEntry)
      .filter((e): e is CustomPriceEntry => e !== null);
    if (entries.length === 0) return;
    setDraft((prev) => {
      let next = prev;
      for (const entry of entries) next = setCustomPrice(next, entry);
      return next;
    });
    toast.success(
      `${entries.length} existing Apple price${entries.length === 1 ? "" : "s"} imported as custom — they will now survive the next push.`,
    );
  }

  const importedThisSession = useRef(false);
  function markImported() {
    importedThisSession.current = true;
  }

  async function handleSave() {
    setSaving(true);
    try {
      const entries = toCustomPriceEntries(draft);
      const res = await fetch(
        `/api/iap-management/iaps/${iapId}/custom-prices`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            custom_prices: entries,
            custom_prices_baseline: entries.length > 0 ? currentBaseline : null,
            source: importedThisSession.current ? "imported-from-apple" : "manual",
          }),
        },
      );
      const data = (await res.json()) as
        | { ok: true; kind: string; entries: CustomPriceEntry[] }
        | { error: string };
      if (!res.ok || "error" in data) {
        toast.error("error" in data ? data.error : `Save failed (${res.status})`);
        return;
      }
      toast.success(
        entries.length === 0
          ? "Custom prices cleared"
          : `${entries.length} custom price${entries.length === 1 ? "" : "s"} saved`,
      );
      importedThisSession.current = false;
      onSaved(entries, entries.length > 0 ? currentBaseline : null);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Custom territory prices"
    >
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Custom territory prices
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                Base{" "}
                <strong>
                  {baseline?.base_territory ?? "USA"}
                  {baseline?.base_price != null && ` · $${baseline.base_price.toFixed(2)}`}
                </strong>
                {currentBaseline && (
                  <>
                    {" · "}Tier <strong>{currentBaseline.tier_id}</strong>
                    {" · "}Source <strong>{currentBaseline.pricing_source}</strong>
                  </>
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-slate-400 hover:text-slate-600"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <p className="mt-3 rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700 p-2.5 text-[11px] text-slate-600 dark:text-slate-300">
            Pick from the price points <strong>Apple supports in that territory</strong>.
            Territories you don&apos;t touch keep the template value, or Apple&apos;s
            auto-equalisation — exactly as today.
          </p>

          {/* STALE banner (§D) — SC3 wires the submit block; this shows the state
              and the two one-click resolutions. */}
          {stale && counts.customised > 0 && (
            <div
              data-testid="custom-prices-stale-banner"
              className="mt-3 rounded-lg border-2 border-amber-400 bg-amber-50 dark:bg-amber-900/20 p-3"
            >
              <div className="flex gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">
                    {counts.customised} custom price
                    {counts.customised === 1 ? " was" : "s were"} set against a different base
                  </p>
                  <p className="text-[11px] text-amber-800 dark:text-amber-300/90 mt-1">
                    Set against tier <strong>{storedBaseline?.tier_id}</strong> ·{" "}
                    {storedBaseline?.pricing_source}. The base is now{" "}
                    <strong>{currentBaseline?.tier_id ?? "unset"}</strong>. Nothing has been
                    deleted — review them before pushing to Apple.
                  </p>
                  <div className="flex gap-2 mt-2">
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={saving}
                      className="px-3 py-1.5 rounded-md bg-white border border-amber-400 text-amber-900 text-[11px] font-medium disabled:opacity-50"
                    >
                      Keep them (reviewed)
                    </button>
                    <button
                      type="button"
                      onClick={handleClearAll}
                      className="px-3 py-1.5 rounded-md bg-white border border-red-300 text-red-700 text-[11px] font-medium"
                    >
                      Clear all custom prices
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* J-6 bulk import — a PRIMARY affordance, not a footnote. */}
          {importable.length > 0 && (
            <div
              data-testid="custom-prices-import-banner"
              className="mt-3 rounded-lg border-2 border-violet-300 bg-violet-50 dark:bg-violet-900/20 p-3"
            >
              <div className="flex items-start gap-2">
                <Download className="h-4 w-4 text-violet-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-xs font-semibold text-violet-900 dark:text-violet-200">
                    {importable.length} territor
                    {importable.length === 1 ? "y has" : "ies have"} a price set on Apple that
                    the next push will erase
                  </p>
                  <p className="text-[11px] text-violet-800 dark:text-violet-300/90 mt-1">
                    Apple replaces the whole price schedule on every push, so a manual price
                    that isn&apos;t re-sent reverts to auto-equalisation. Import them as custom
                    prices to keep them.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    markImported();
                    handleImportAll();
                  }}
                  className="flex-shrink-0 px-3 py-1.5 rounded-md bg-violet-600 text-white text-[11px] font-medium"
                >
                  Import all as custom prices
                </button>
              </div>
            </div>
          )}

          {!donorAvailable && !loading && (
            <p
              data-testid="custom-prices-no-donor"
              className="mt-3 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-900/20 p-2.5 text-[11px] text-amber-900 dark:text-amber-200"
            >
              {NO_DONOR_REASON}
            </p>
          )}

          {baseline?.warnings.map((w) => (
            <p
              key={w}
              className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-600"
            >
              {w}
            </p>
          ))}
        </div>

        {/* Toolbar + table — chrome lives in the shared shell (SC4 §G4). The
            "Only customised" filter and the count chip are ours: the shell
            owns the frame and the filter pipeline, never what is counted. */}
        <TerritoryPickerShell<BaselineRow>
          items={rows}
          codeOf={rowCode}
          matches={matchesBaselineQuery}
          extraFilter={onlyCustomised ? notCustomisedFilter : undefined}
          resetKey={filterEpoch}
          searchPlaceholder="Search territory, code, or currency…"
          emptyLabel="No territories match the current filter."
          loading={loading}
          loadError={loadError}
          columnCount={6}
          columns={
            <>
              <th className="px-5 py-2.5 font-semibold">Territory</th>
              <th className="px-3 py-2.5 font-semibold">Currency</th>
              <th className="px-3 py-2.5 font-semibold">Current price · provenance</th>
              <th className="px-3 py-2.5 font-semibold w-56">Custom price</th>
              <th className="px-3 py-2.5 font-semibold text-right">New price</th>
              <th className="px-3 py-2.5" />
            </>
          }
          toolbarSlot={
            <label className="flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-300 ml-auto">
              <input
                type="checkbox"
                checked={onlyCustomised}
                onChange={(e) => setOnlyCustomised(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-300"
              />
              Only customised ({counts.customised})
            </label>
          }
          countSlot={
            <span
              data-testid="custom-prices-changed-count"
              className="px-2 py-1 rounded bg-amber-100 text-amber-900 text-[11px] font-semibold"
            >
              {counts.customised} customised
            </span>
          }
          renderRow={(row) => (
            <Row
              key={row.territory_code}
              row={row}
              options={options[row.territory_code] ?? { status: "idle" }}
              donorAvailable={donorAvailable}
              onOpenPicker={() => loadOptions(row.territory_code)}
              onPick={(raw) => handlePick(row, raw)}
              onRevert={() => handleRevert(row)}
              onImport={() => {
                markImported();
                handleImportRow(row);
              }}
            />
          )}
        />

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30 flex items-center justify-between gap-3">
          <div className="text-[11px] text-slate-600 dark:text-slate-300">
            <span className="font-semibold">{counts.customised}</span> of {counts.total}{" "}
            territories customised
            {counts.unavailable > 0 && (
              <span className="ml-2 text-red-700 font-medium">
                · {counts.unavailable} no longer offered by Apple
              </span>
            )}
            <button
              type="button"
              onClick={handleClearAll}
              disabled={counts.customised === 0}
              className="ml-3 text-red-600 hover:underline disabled:opacity-40 disabled:no-underline"
            >
              Clear all custom prices
            </button>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-medium"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1.5 rounded-md bg-[#0071E3] text-white text-xs font-medium disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save custom prices"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({
  row,
  options,
  donorAvailable,
  onOpenPicker,
  onPick,
  onRevert,
  onImport,
}: {
  row: BaselineRow;
  options: PriceOptionState;
  donorAvailable: boolean;
  onOpenPicker: () => void;
  onPick: (raw: string) => void;
  onRevert: () => void;
  onImport: () => void;
}) {
  const customised = row.custom_price !== null;
  const rowClass = row.is_base
    ? "bg-slate-50 dark:bg-slate-800/40"
    : row.custom_unavailable
      ? "bg-amber-100 dark:bg-amber-900/30 shadow-[inset_3px_0_0_#d97706]"
      : customised
        ? "bg-amber-50 dark:bg-amber-900/20 shadow-[inset_3px_0_0_#fbbf24]"
        : "hover:bg-slate-50 dark:hover:bg-slate-800/30";

  return (
    <tr className={rowClass} data-testid={`custom-price-row-${row.territory_code}`}>
      <td className="px-5 py-2.5">
        <span className="font-medium text-slate-800 dark:text-slate-100">
          {row.territory_name}
        </span>
        <span className="ml-1.5 font-mono text-[10px] text-slate-400">
          {row.territory_code}
        </span>
        {row.is_base && (
          <span className="ml-1.5 px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 text-[9px] font-semibold uppercase">
            Base
          </span>
        )}
        {row.custom_unavailable && (
          <span className="ml-1.5 px-1.5 py-0.5 rounded bg-red-200 text-red-900 text-[9px] font-semibold">
            no longer offered
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 font-mono text-slate-500">{row.currency_code ?? "—"}</td>
      <td className="px-3 py-2.5">
        {row.current_price === null ? (
          <span className="text-slate-400 italic">— auto —</span>
        ) : (
          <span className={`font-mono ${customised ? "text-slate-400 line-through" : ""}`}>
            {row.current_price}
          </span>
        )}
        <span className="ml-2 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[9px] font-medium">
          {provenanceLabel(row.provenance)}
        </span>
        {/* J-6 — stated on EVERY such row, per G5 the most important thing here. */}
        {row.provenance === "existing-manual" && (
          <div className="mt-0.5 text-[10px] text-violet-800 dark:text-violet-300">
            {EXISTING_MANUAL_WARNING}
            {!customised && (
              <button
                type="button"
                onClick={onImport}
                className="ml-1 underline font-medium"
              >
                Import as custom price
              </button>
            )}
          </div>
        )}
      </td>
      <td className="px-3 py-2.5">
        {row.is_base ? (
          // §E — read-only. The base is a TIER, set in the Price Tier field; the
          // write path has exactly one base slot and the template loop excludes
          // the base territory.
          <span className="text-[11px] text-slate-500 italic">
            This is the base price — set it in <span className="not-italic font-medium">Price Tier</span> above.
          </span>
        ) : !donorAvailable ? (
          <span className="text-[11px] text-slate-400 italic">Picker unavailable</span>
        ) : (
          <select
            aria-label={`Custom price for ${row.territory_name}`}
            value={row.custom_price ?? ""}
            onFocus={onOpenPicker}
            onMouseDown={onOpenPicker}
            onChange={(e) => onPick(e.target.value)}
            className={`w-full rounded-md border px-2 py-1 text-xs bg-white dark:bg-slate-900 ${
              customised
                ? "border-amber-400 font-medium"
                : "border-slate-300 dark:border-slate-700 text-slate-500"
            }`}
          >
            {/* The placeholder NAMES the fallback rather than being blank, so
                "empty" never has to be inferred. It is also the per-row revert. */}
            <option value="">
              {`— use ${provenanceLabel(row.provenance)}${
                row.current_price !== null ? ` ${row.current_price}` : ""
              } —`}
            </option>
            {options.status === "ready" &&
              options.prices.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            {/* Keep a withdrawn stored value selectable/visible instead of
                silently dropping it — §I.3. */}
            {options.status === "ready" &&
              row.custom_price !== null &&
              !options.prices.includes(row.custom_price) && (
                <option value={row.custom_price}>
                  {row.custom_price} — not in Apple&apos;s list
                </option>
              )}
            {options.status !== "ready" && row.custom_price !== null && (
              <option value={row.custom_price}>{row.custom_price}</option>
            )}
          </select>
        )}
        {options.status === "loading" && (
          <p className="text-[10px] text-slate-400 mt-0.5">Loading Apple prices…</p>
        )}
        {options.status === "error" && (
          <p className="text-[10px] text-red-600 mt-0.5">{options.message}</p>
        )}
        {options.status === "no-donor" && (
          <p className="text-[10px] text-amber-700 mt-0.5">{NO_DONOR_REASON}</p>
        )}
        {row.custom_unavailable && (
          <p className="text-[10px] text-red-700 mt-0.5">
            Apple withdrew this price point. Pick a replacement or revert.
          </p>
        )}
      </td>
      <td className="px-3 py-2.5 text-right font-mono font-semibold text-amber-900 dark:text-amber-200">
        {row.custom_price ?? <span className="text-slate-300 font-normal">—</span>}
      </td>
      <td className="px-3 py-2.5 text-right">
        {customised && (
          <button
            type="button"
            onClick={onRevert}
            title={`Revert to ${provenanceLabel(row.provenance)}`}
            className="px-1.5 py-0.5 rounded text-[10px] text-slate-500 hover:text-red-600"
          >
            Revert ×
          </button>
        )}
      </td>
    </tr>
  );
}
