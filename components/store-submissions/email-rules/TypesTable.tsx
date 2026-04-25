'use client';

import { useMemo } from 'react';
import { Plus, X } from 'lucide-react';

import {
  addRow,
  nextNumericField,
  removeRow,
  safeSlugFromName,
  updateRow,
  type TypeDraft,
} from './helpers';
import { RegexInput } from './RegexInput';

export interface TypesTableProps {
  types: TypeDraft[];
  onChange: (next: TypeDraft[]) => void;
}

const emptyType = (): TypeDraft => ({
  name: '',
  slug: '',
  body_keyword: '',
  payload_extract_regex: null,
  sort_order: 100,
  active: true,
});

export function TypesTable({ types, onChange }: TypesTableProps) {
  const sortedView = useMemo(
    () =>
      types
        .map((t, sourceIdx) => ({ type: t, sourceIdx }))
        .sort((a, b) => a.type.sort_order - b.type.sort_order),
    [types],
  );

  const handleNameChange = (sourceIdx: number, name: string) =>
    onChange(updateRow(types, sourceIdx, { name }));

  /**
   * Auto-derive slug on blur — only if the current slug is empty OR matches
   * what the previous name would have generated (i.e. Manager hasn't
   * overridden it). Once a Manager edits the slug field, it becomes
   * sticky: further name edits don't overwrite it.
   */
  const handleNameBlur = (sourceIdx: number) => {
    const current = types[sourceIdx];
    if (!current) return;
    if (current.slug.trim() !== '') return;
    const derived = safeSlugFromName(current.name);
    if (derived === '') return;
    onChange(updateRow(types, sourceIdx, { slug: derived }));
  };

  const handleSlugChange = (sourceIdx: number, slug: string) =>
    onChange(updateRow(types, sourceIdx, { slug }));

  const handleBodyKeywordChange = (sourceIdx: number, body_keyword: string) =>
    onChange(updateRow(types, sourceIdx, { body_keyword }));

  /**
   * null (field cleared) and "" are treated differently downstream: zod
   * accepts `null` for "no payload extraction" and rejects "" (empty string)
   * via the superRefine validator. Coerce empty → null here so the Manager
   * doesn't need to know the distinction.
   */
  const handlePayloadRegexChange = (sourceIdx: number, next: string) => {
    const normalized = next.trim() === '' ? null : next;
    onChange(updateRow(types, sourceIdx, { payload_extract_regex: normalized }));
  };

  const handleSortOrderChange = (sourceIdx: number, raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) return;
    const clamped = Math.max(0, Math.min(10_000, parsed));
    onChange(updateRow(types, sourceIdx, { sort_order: clamped }));
  };

  const handleActiveToggle = (sourceIdx: number) => {
    const current = types[sourceIdx];
    if (!current) return;
    onChange(updateRow(types, sourceIdx, { active: !current.active }));
  };

  const handleRemove = (sourceIdx: number) =>
    onChange(removeRow(types, sourceIdx));

  const handleAdd = () =>
    onChange(
      addRow(types, {
        ...emptyType(),
        sort_order: nextNumericField(types, 'sort_order'),
      }),
    );

  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <h2 className="text-[15px] font-semibold">Types</h2>
          <p className="text-[12.5px] text-slate-500 mt-0.5">
            Body keyword để detect Type. Payload regex extract metadata từ
            body (version, event ID, page ID…). Ticket gom theo (app + type +
            platform).
          </p>
        </div>
        <button
          type="button"
          onClick={handleAdd}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12.5px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.8} />
          Add type
        </button>
      </div>

      <AppleHtmlTypeGuidance />

      {types.length === 0 && (
        <div className="bg-white border border-dashed border-slate-200 rounded-xl px-4 py-6 text-[12.5px] text-slate-500 italic">
          No types — every classified email will skip Step 4 (type detection).
        </div>
      )}

      <div className="space-y-3">
        {sortedView.map(({ type, sourceIdx }) => (
          <div
            key={sourceIdx}
            className="bg-white border border-slate-200 rounded-xl p-4"
          >
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-md bg-violet-50 text-violet-700 border border-violet-200">
                {type.slug || 'new-type'}
              </span>
              <label className="inline-flex items-center gap-1.5 text-[11.5px] text-slate-500 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={type.active}
                  onChange={() => handleActiveToggle(sourceIdx)}
                  className="h-3.5 w-3.5 accent-slate-900"
                />
                Active
              </label>
              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Remove type"
                  onClick={() => handleRemove(sourceIdx)}
                  className="text-slate-400 hover:text-red-600 p-1"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-3 text-[12.5px]">
              <label className="text-slate-500 pt-2">Name</label>
              <input
                type="text"
                value={type.name}
                onChange={(e) => handleNameChange(sourceIdx, e.target.value)}
                onBlur={() => handleNameBlur(sourceIdx)}
                placeholder="App / In-App Event / Custom Product Page"
                className="px-2.5 py-1.5 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
              />

              <label className="text-slate-500 pt-2">Slug</label>
              <input
                type="text"
                value={type.slug}
                onChange={(e) => handleSlugChange(sourceIdx, e.target.value)}
                placeholder="auto-derived from name on blur"
                className="px-2.5 py-1.5 border border-slate-200 rounded-md font-mono focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
              />

              <label className="text-slate-500 pt-2">Body keyword</label>
              <input
                type="text"
                value={type.body_keyword}
                onChange={(e) =>
                  handleBodyKeywordChange(sourceIdx, e.target.value)
                }
                placeholder="App Version / In-App Events / Custom Product Pages"
                className="px-2.5 py-1.5 border border-slate-200 rounded-md font-mono focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
              />

              <label className="text-slate-500 pt-2">Payload regex</label>
              <RegexInput
                kind="payload"
                allowEmpty
                value={type.payload_extract_regex ?? ''}
                onChange={(next) => handlePayloadRegexChange(sourceIdx, next)}
                placeholder="App Version\n(?<version>[\\d.]+) for (?<os>\\w+)"
                ariaLabel="Payload regex"
              />

              <label className="text-slate-500 pt-2">Sort order</label>
              <input
                type="number"
                min={0}
                max={10_000}
                value={type.sort_order}
                onChange={(e) =>
                  handleSortOrderChange(sourceIdx, e.target.value)
                }
                className="w-28 px-2 py-1 border border-slate-200 rounded-md text-[12.5px] font-mono focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Static guidance card. Documents the 4 Apple HTML headings the
 * extractor (PR-11.1) auto-detects, mapped to the corresponding type
 * slugs. Manager-facing context: when the body keyword path misses
 * (which it always does for Apple — text/plain has no type signal),
 * the structural extractor catches these via Priority 1 in
 * `matchType`. New variants surface as `UNKNOWN` and fire a Sentry
 * warning so the extractor can be extended.
 *
 * Per Q2 (PR-11 scope): static markdown card, no interactive
 * preview / live validation. Easy to maintain + future-expandable.
 */
function AppleHtmlTypeGuidance() {
  return (
    <details className="mb-3 group bg-white border border-slate-200 rounded-xl">
      <summary className="cursor-pointer select-none list-none flex items-center gap-1.5 px-4 py-3 text-[12.5px] font-medium text-slate-700">
        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold">
          ?
        </span>
        Apple HTML auto-detection (PR-11) — 4 supported types
      </summary>
      <div className="px-4 pb-4 pt-1 text-[12.5px] text-slate-600 space-y-3">
        <p>
          Apple submission emails carry their type signal in the HTML
          alternative under <code className="font-mono">&lt;h2&gt;Accepted items&lt;/h2&gt;</code>.
          The extractor walks the next-sibling <code className="font-mono">&lt;h3&gt;</code>{' '}
          headings and maps each to a DB type slug.
        </p>
        <dl className="space-y-2">
          <div>
            <dt className="font-mono text-[11.5px] text-slate-900">
              app — App Version
            </dt>
            <dd className="text-[11.5px] text-slate-500 ml-3">
              <code className="font-mono">
                &lt;h3&gt;App Version&lt;/h3&gt;&lt;p&gt;{'{version}'} for {'{platform}'}&lt;/p&gt;
              </code>{' '}
              · Example: 1.0.13 for iOS
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[11.5px] text-slate-900">
              iae — In-App Events
            </dt>
            <dd className="text-[11.5px] text-slate-500 ml-3">
              <code className="font-mono">
                &lt;h3&gt;In-App Events ({'{count}'})&lt;/h3&gt;
              </code>{' '}
              · Count baked into heading; no body
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[11.5px] text-slate-900">
              cpp — Custom Product Pages
            </dt>
            <dd className="text-[11.5px] text-slate-500 ml-3">
              <code className="font-mono">
                &lt;h3&gt;Custom Product Pages&lt;/h3&gt;&lt;p&gt;{'{name}'}&lt;br&gt;{'{uuid}'}&lt;/p&gt;
              </code>{' '}
              · Example: CPP 2004 / e2232a07-…
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[11.5px] text-slate-900">
              ppo — Product Page Optimization
            </dt>
            <dd className="text-[11.5px] text-slate-500 ml-3">
              <code className="font-mono">
                &lt;h3&gt;Product Page Optimization&lt;/h3&gt;&lt;p&gt;{'{version_code}'}&lt;/p&gt;
              </code>{' '}
              · Example: 230426
            </dd>
          </div>
        </dl>
        <p className="text-[11.5px] text-slate-500">
          Other variations classify as <span className="font-mono">UNCLASSIFIED_TYPE</span>{' '}
          and emit a Sentry warning <span className="font-mono">component=html-extractor</span>{' '}
          so the extractor can be extended. Body keyword (above) is
          Priority 2 — used as fallback for non-Apple platforms or
          UNKNOWN headings.
        </p>
      </div>
    </details>
  );
}
