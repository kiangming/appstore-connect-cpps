"use client";

/**
 * Per-item custom-prices dialog (Bulk Import Step 3).
 *
 * Lets one row override its prices per country, independently of the batch
 * template. Custom prices are ABSOLUTE: once saved they are not tied to
 * the template any more, and survive a template change (Manager-locked).
 *
 * REUSE, NOT A SECOND EDITOR: the price input is the shared
 * `RegionPriceCell` — the same component the item-detail view renders
 * (SC1). Validation is `validateCustomPrices` from
 * lib/google-iap-management/custom-prices.ts, which delegates to the same
 * `validateDecimalForCurrency` the detail form uses. Neither the rules nor
 * the control can drift between the two surfaces.
 *
 * Two things this dialog makes VISIBLE that would otherwise be silent:
 *  1. A blank price is not "unpriced" — the orchestrator's regions
 *     bootstrap fills it from Google's conversion
 *     (bulk-import.ts:839-846). Blank rows say so in words.
 *  2. Google needs a defaultPrice, derived from the app-currency entry
 *     (Q6). Missing it means a server-side refusal at push; the Save gate
 *     surfaces it here instead, while it can still be fixed.
 */
import { useEffect, useMemo, useState } from "react";
import { X, Search, AlertTriangle, Loader2, Info } from "lucide-react";

import { decimalToMicros } from "@/lib/google-iap-management/google/price-conversion";

import { RegionPriceCell } from "@/components/google-iap-management/pricing/RegionPriceCell";
import {
  buildCustomPriceRows,
  validateCustomPrices,
  summarizeCustomPrices,
  findAppCurrencyEntry,
  flagSuspiciousDrops,
  toCustomEntries,
  type CatalogCountry,
  type CustomEntry,
  type CustomPriceRow,
  type TemplateEntry,
} from "@/lib/google-iap-management/custom-prices";
import {
  CONTINENTS,
  getContinentForRegion,
  type Continent,
} from "@/lib/google-iap-management/region-continent";

export interface CustomBaseline {
  kind: "template";
  scope: "ACCOUNT" | "APP";
  identifier: string;
}

export interface CustomPriceSet {
  entries: CustomEntry[];
  baseline: CustomBaseline | { kind: "none" };
  editedAt: string;
}

interface Props {
  sku: string;
  /** Label for the batch's template scope, e.g. "Default Template". */
  sourceLabel: string;
  /** Tier this row resolved to, or null when nothing matched — and always
   *  null under Google Conversion, where no template is involved. */
  tierIdentifier: string | null;
  /** True when the batch source is Google Conversion. Only affects copy:
   *  "no template match" would be misleading there, since not having a
   *  template is the point of the source, not a miss. */
  isGoogleConversion?: boolean;
  scope: "ACCOUNT" | "APP";
  appId: string;
  packageName: string;
  appDefaultCurrency: string | null;
  /** The row's base price, forwarded to the catalog route so Google's own
   *  conversion of THIS price can act as the reference column under Google
   *  Conversion, where there is no template to compare against. */
  baseCurrency: string;
  basePriceDecimal: string;
  /** Already-saved set when re-opening; null on first open. */
  existing: CustomPriceSet | null;
  /** True once the row's customs were saved against a template that has
   *  since changed — the header says so and the Template column shows the
   *  NEW template's values for comparison. */
  baselineChanged: boolean;
  onSave: (set: CustomPriceSet) => void;
  /** Drops the whole custom set for this row. Named "clear" rather than
   *  "reset to template" — under Google Conversion there is no template to
   *  reset to; the row simply falls back to the batch pricing source. */
  onClearAll: () => void;
  onClose: () => void;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; countries: CatalogCountry[]; template: TemplateEntry[] };

export function CustomPricesDialog({
  sku,
  sourceLabel,
  tierIdentifier,
  isGoogleConversion = false,
  scope,
  appId,
  packageName,
  appDefaultCurrency,
  baseCurrency,
  basePriceDecimal,
  existing,
  baselineChanged,
  onSave,
  onClearAll,
  onClose,
}: Props) {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  // Typed values, keyed by region. Seeded from `existing` on open; a
  // region absent from the map is untouched, "" means explicitly cleared.
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [continent, setContinent] = useState<Continent | "All">("All");
  const [changedOnly, setChangedOnly] = useState(false);
  /**
   * Regions the user opened for editing but hasn't given a value to yet.
   *
   * PRESENTATION ONLY — deliberately not folded into `typed`, because the
   * data model treats an empty price as "no price" (blank = let Google
   * convert), which is correct and must stay that way. Without this,
   * "set price" was a DEAD BUTTON wherever there was no template value to
   * seed from: it wrote "", the row model read that back as blank, and
   * the cell re-rendered as "inherits" — i.e. nothing happened. That is
   * every country under Google Conversion.
   */
  const [editing, setEditing] = useState<Set<string>>(new Set());

  /** Micros for the catalog probe. Null when the row's base price is
   *  unusable — the dialog still works, it just loses the reference
   *  column rather than failing to open. */
  const baseMicros = useMemo(() => {
    try {
      return decimalToMicros(basePriceDecimal, baseCurrency);
    } catch {
      return null;
    }
  }, [basePriceDecimal, baseCurrency]);

  useEffect(() => {
    let cancelled = false;
    async function loadAll() {
      setLoad({ kind: "loading" });
      try {
        // Base price threaded through so the response carries Google's
        // converted amount per country — free, the route already makes
        // this exact call (see its `basePriceMicros` note).
        const catalogUrl =
          `/api/google-iap-management/regions/catalog?packageName=${encodeURIComponent(packageName)}` +
          (baseMicros
            ? `&basePriceMicros=${encodeURIComponent(baseMicros)}&baseCurrency=${encodeURIComponent(baseCurrency)}`
            : "");
        const catalogReq = fetch(catalogUrl);
        const tierReq = tierIdentifier
          ? fetch(
              `/api/google-iap-management/pricing-templates/tier-entries?scope=${scope}` +
                `&appId=${encodeURIComponent(appId)}&identifier=${encodeURIComponent(tierIdentifier)}`,
            )
          : null;
        const [catalogRes, tierRes] = await Promise.all([catalogReq, tierReq]);

        const catalogBody = (await catalogRes.json().catch(() => ({}))) as {
          regions?: CatalogCountry[];
          error?: string;
        };
        if (!catalogRes.ok) {
          throw new Error(catalogBody.error ?? `Country list failed (HTTP ${catalogRes.status}).`);
        }
        let template: TemplateEntry[] = [];
        if (tierRes) {
          const tierBody = (await tierRes.json().catch(() => ({}))) as {
            entries?: TemplateEntry[];
            error?: string;
          };
          if (!tierRes.ok) {
            throw new Error(tierBody.error ?? `Tier prices failed (HTTP ${tierRes.status}).`);
          }
          template = tierBody.entries ?? [];
        }
        if (!cancelled) {
          setLoad({ kind: "ready", countries: catalogBody.regions ?? [], template });
          // Seed the editable values. Re-open → the SAVED set verbatim
          // (a country the Manager deliberately cleared must STAY blank,
          // so the template is not consulted at all in that branch).
          // First open → the template baseline, which is the whole point
          // of "pre-filled from tier X": countries the template covers
          // start as editable inputs holding its value; countries it
          // doesn't cover start blank and say "Google conversion".
          const seed: Record<string, string> = {};
          if (existing) {
            for (const e of existing.entries) seed[e.region] = e.priceDecimal;
          } else {
            for (const e of template) seed[e.regionCode] = e.priceDecimal;
          }
          setTyped(seed);
        }
      } catch (err) {
        if (!cancelled) {
          setLoad({
            kind: "error",
            message: err instanceof Error ? err.message : "Failed to load.",
          });
        }
      }
    }
    void loadAll();
    return () => {
      cancelled = true;
    };
    // `existing` is intentionally in the dep list: re-opening after a
    // save must re-seed from the saved set, not the stale template.
  }, [packageName, scope, appId, tierIdentifier, existing, baseMicros, baseCurrency]);

  const rows: CustomPriceRow[] = useMemo(() => {
    if (load.kind !== "ready") return [];
    const custom: CustomEntry[] = Object.entries(typed)
      .filter(([, v]) => v.trim() !== "")
      .map(([region, priceDecimal]) => ({ region, currency: "", priceDecimal }));
    // Reference column: the template when there is one, otherwise Google's
    // conversion of this row's base price. Both are "what this country
    // would get if you changed nothing", which is what the Δ and the
    // below-floor heuristic need.
    const reference: TemplateEntry[] =
      load.template.length > 0
        ? load.template
        : load.countries
            .filter((c) => c.convertedDecimal)
            .map((c) => ({
              regionCode: c.regionCode,
              currency: c.currency,
              priceDecimal: c.convertedDecimal as string,
            }));
    return buildCustomPriceRows({
      countries: load.countries,
      templateEntries: reference,
      custom,
    });
  }, [load, typed]);

  const errors = useMemo(() => validateCustomPrices(rows), [rows]);
  const errorByRegion = useMemo(
    () => Object.fromEntries(errors.map((e) => [e.regionCode, e.error])),
    [errors],
  );
  const warnings = useMemo(() => flagSuspiciousDrops(rows), [rows]);
  const warningByRegion = useMemo(
    () => Object.fromEntries(warnings.map((w) => [w.regionCode, w.message])),
    [warnings],
  );
  const summary = useMemo(() => summarizeCustomPrices(rows), [rows]);
  /**
   * The app-currency entry is required ONLY under a template source,
   * where the custom set replaces the whole price set and is therefore
   * the only possible source of defaultPrice. Under Google Conversion the
   * set is a sparse overlay and defaultPrice comes from the file's base
   * price — gating Save there would block someone overriding three
   * countries, none of them the app's own, which is exactly what this
   * source is for. Mirrors the orchestrator's branch; the two must agree,
   * or the UI blocks what the server would happily accept.
   */
  const appCurrencyCheck = useMemo(
    () =>
      isGoogleConversion
        ? ({ ok: true, regionCode: "" } as const)
        : findAppCurrencyEntry(rows, appDefaultCurrency),
    [rows, appDefaultCurrency, isGoogleConversion],
  );

  const nothingTyped = summary.customised === 0 && rows.every((r) => r.customDecimal === null);
  const canSave = errors.length === 0 && appCurrencyCheck.ok && !nothingTyped;

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (changedOnly && r.state !== "custom") return false;
      if (continent !== "All" && getContinentForRegion(r.regionCode) !== continent) {
        return false;
      }
      if (!q) return true;
      return (
        r.countryName.toLowerCase().includes(q) ||
        r.regionCode.toLowerCase().includes(q) ||
        r.currency.toLowerCase().includes(q)
      );
    });
  }, [rows, query, continent, changedOnly]);

  function handleSave() {
    if (!canSave) return;
    onSave({
      entries: toCustomEntries(rows),
      baseline: tierIdentifier
        ? { kind: "template", scope, identifier: tierIdentifier }
        : { kind: "none" },
      // Stamped at save so the audit log can record when the Manager set
      // these values, independent of when the batch was pushed.
      editedAt: new Date().toISOString(),
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Custom prices for ${sku}`}
    >
      <div className="bg-white border border-slate-200 rounded-2xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header — baseline provenance stated plainly */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900">
              Custom prices — <span className="font-mono">{sku}</span>
            </h3>
            <p className="text-[11px] text-slate-500 mt-1">
              {baselineChanged ? (
                <>
                  <strong>Custom — no longer tied to a template.</strong> The
                  Template column shows the current {sourceLabel} values so you
                  can compare, or reset.
                </>
              ) : tierIdentifier ? (
                <>
                  Pre-filled from {sourceLabel} tier{" "}
                  <span className="font-mono">{tierIdentifier}</span>
                  {load.kind === "ready" && ` (${load.template.length} countries)`}.
                  Saving makes these prices <strong>absolute</strong> — they stay
                  even if you change the template.
                </>
              ) : isGoogleConversion ? (
                <>
                  <strong>{sourceLabel}</strong> — every country starts blank and
                  takes Google&apos;s converted price. Anything you set here
                  overrides it for that country only; the rest are unaffected.
                </>
              ) : (
                <>
                  <strong>No template match</strong> — every country starts blank
                  and will use Google&apos;s conversion unless you set it.
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close custom prices dialog"
            className="text-slate-400 hover:text-slate-600 transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {load.kind === "loading" && (
          <div className="px-5 py-12 text-center">
            <Loader2 className="h-5 w-5 animate-spin text-slate-400 mx-auto" />
            <p className="text-xs text-slate-500 mt-2">
              Loading Google&apos;s country list and the tier&apos;s prices…
            </p>
          </div>
        )}

        {load.kind === "error" && (
          <div className="px-5 py-8">
            <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>{load.message}</span>
            </div>
          </div>
        )}

        {load.kind === "ready" && (
          <>
            {/* Toolbar */}
            <div className="px-5 py-3 border-b border-slate-100 flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[220px]">
                <Search className="absolute left-2.5 top-2 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search country, ISO code, or currency…"
                  aria-label="Search countries"
                  className="w-full rounded-lg border border-slate-300 pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
              <div className="flex items-center gap-1">
                {(["All", ...CONTINENTS] as Array<Continent | "All">).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setContinent(c)}
                    className={
                      continent === c
                        ? "px-2 py-1 rounded-full border border-slate-800 bg-slate-800 text-white text-[11px] font-medium"
                        : "px-2 py-1 rounded-full border border-slate-200 text-slate-600 text-[11px] hover:bg-slate-50"
                    }
                  >
                    {c}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setChangedOnly((v) => !v)}
                className={
                  changedOnly
                    ? "px-2 py-1 rounded-lg border border-violet-300 bg-violet-50 text-violet-700 text-[11px] font-medium"
                    : "px-2 py-1 rounded-lg border border-slate-200 text-slate-600 text-[11px] hover:bg-slate-50"
                }
              >
                Changed only ({summary.customised})
              </button>
            </div>

            {/* Save-time app-currency guard (Q6) — surfaced here, not at
                push. Rendered as soon as it fails rather than on a Save
                click: Save is DISABLED while it fails, so gating the
                explanation behind clicking it would leave a dead button
                with no stated reason. */}
            {!appCurrencyCheck.ok && (
              <div className="mx-5 mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-red-600" />
                <p className="text-[11px] text-red-800">{appCurrencyCheck.reason}</p>
              </div>
            )}
            {nothingTyped && (
              <div className="mx-5 mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                <Info className="h-4 w-4 flex-shrink-0 mt-0.5 text-amber-600" />
                <p className="text-[11px] text-amber-900">
                  No prices set. Type at least one price, or Cancel to keep this
                  row on the template.
                </p>
              </div>
            )}
            {warnings.length > 0 && (
              <div className="mx-5 mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-amber-600" />
                <p className="text-[11px] text-amber-900">
                  {warnings.length} price
                  {warnings.length === 1 ? " is" : "s are"} far below the template
                  baseline. Google may reject a price under a country&apos;s
                  minimum — and it reports no per-row reason, so one bad price
                  can fail the whole batch.
                </p>
              </div>
            )}

            {/* Table */}
            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white shadow-[0_1px_0_0_#f1f5f9]">
                  <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400">
                    <th className="px-5 py-2 font-medium">Country</th>
                    <th className="px-5 py-2 font-medium">Currency</th>
                    <th className="px-5 py-2 font-medium">Price · editable</th>
                    <th className="px-5 py-2 font-medium">Template · reference</th>
                    <th className="px-5 py-2 font-medium">Δ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleRows.map((r) => (
                    <DialogRow
                      key={r.regionCode}
                      row={r}
                      error={errorByRegion[r.regionCode]}
                      warning={warningByRegion[r.regionCode]}
                      editing={editing.has(r.regionCode)}
                      onBeginEdit={() =>
                        setEditing((prev) => new Set(prev).add(r.regionCode))
                      }
                      onChange={(v) =>
                        setTyped((prev) => ({ ...prev, [r.regionCode]: v }))
                      }
                      onClear={() => {
                        setTyped((prev) => {
                          const next = { ...prev };
                          delete next[r.regionCode];
                          return next;
                        });
                        setEditing((prev) => {
                          const next = new Set(prev);
                          next.delete(r.regionCode);
                          return next;
                        });
                      }}
                    />
                  ))}
                  {visibleRows.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-5 py-8 text-center text-slate-400 text-xs">
                        No countries match this filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
              <p className="text-[11px] text-slate-500">
                <strong className="text-violet-700">{summary.customised}</strong> of{" "}
                {summary.total} customised ·{" "}
                <strong className="text-slate-700">{summary.atTemplate}</strong>{" "}
                unchanged ·{" "}
                <strong className="text-slate-700">{summary.blank}</strong> blank
                (Google conversion)
                {errors.length > 0 && (
                  <span className="ml-2 font-medium text-red-700">
                    · {errors.length} invalid · Save is blocked
                  </span>
                )}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClearAll}
                  className="px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700 transition"
                >
                  Clear custom prices
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={!canSave}
                  className="px-4 py-1.5 text-xs font-semibold text-white bg-violet-600 hover:bg-violet-700 rounded-lg transition disabled:bg-slate-300 disabled:cursor-not-allowed"
                >
                  Save custom prices
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DialogRow({
  row,
  error,
  warning,
  editing,
  onBeginEdit,
  onChange,
  onClear,
}: {
  row: CustomPriceRow;
  error?: string;
  warning?: string;
  editing: boolean;
  onBeginEdit: () => void;
  onChange: (v: string) => void;
  onClear: () => void;
}) {
  const delta = (() => {
    if (row.customDecimal === null || row.templateDecimal === null) return null;
    const c = Number(row.customDecimal);
    const t = Number(row.templateDecimal);
    if (!Number.isFinite(c) || !Number.isFinite(t) || t <= 0) return null;
    const pct = Math.round(((c - t) / t) * 100);
    if (pct === 0) return null;
    return pct;
  })();

  return (
    <tr className={row.state === "custom" ? "bg-violet-50/60" : undefined}>
      <td className="px-5 py-2.5 text-slate-700 align-top">
        {row.countryName}{" "}
        <span className="text-slate-400 font-mono text-xs">({row.regionCode})</span>
      </td>
      <td className="px-5 py-2.5 align-top">
        <span className="inline-flex rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
          {row.currency || "—"}
        </span>
      </td>
      <td className="px-5 py-2.5 align-top">
        {row.customDecimal === null && !editing ? (
          /* Blank is NOT "unpriced" — the orchestrator's bootstrap fills it
             from Google's conversion (bulk-import.ts:839-846). Say so. */
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-400 italic px-2 py-1 rounded-md border border-dashed border-slate-300">
            inherits — Google conversion ·{" "}
            <button
              type="button"
              onClick={() => {
                onBeginEdit();
                // Seed from the reference when there is one; otherwise the
                // cell simply opens empty and ready to type.
                if (row.templateDecimal) onChange(row.templateDecimal);
              }}
              className="not-italic font-medium text-violet-700 hover:underline"
            >
              set price
            </button>
          </span>
        ) : (
          <>
            <RegionPriceCell
              regionCode={row.regionCode}
              currency={row.currency}
              priceDecimal={row.customDecimal ?? ""}
              error={error}
              onChange={onChange}
              onClear={onClear}
              ariaLabel={`Custom price for ${row.regionCode}`}
              clearAriaLabel={`Clear custom price for ${row.regionCode}`}
              placeholder="set price"
            />
            {!error && warning && (
              <p className="mt-1 text-[11px] text-amber-700">{warning}</p>
            )}
          </>
        )}
      </td>
      <td className="px-5 py-2.5 align-top font-mono text-xs text-slate-500">
        {row.templateDecimal
          ? `${row.currency} ${row.templateDecimal}`
          : "not in template"}
      </td>
      <td className="px-5 py-2.5 align-top text-xs">
        {delta === null ? (
          <span className="text-slate-400">—</span>
        ) : (
          <span className={delta < 0 ? "font-semibold text-rose-600" : "font-semibold text-emerald-600"}>
            {delta > 0 ? "+" : ""}
            {delta}%
          </span>
        )}
      </td>
    </tr>
  );
}
