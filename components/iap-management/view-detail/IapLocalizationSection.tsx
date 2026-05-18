/**
 * IAP.p2.e — App Store Localization section of the View Detail page.
 *
 * Renders one row per Apple-side localization (display name, description,
 * per-locale review state) inside the p2.b DataTable primitive. The locale
 * column links to the edit page focused on that locale; Q-A view-only v1 →
 * the link targets the edit route, not an inline editor.
 *
 * Layout follows the mockup:
 *   SectionShell (title + "+" adornment + helper line)
 *   └─ DataTable
 *      cols: LOCALIZATIONS | DISPLAY NAME | DESCRIPTION | STATUS
 *
 * Q-D 5-colour palette applied per-locale via `statusToneForState`. Apple
 * sometimes omits `attributes.state` on a locale; we default to
 * READY_TO_SUBMIT (neutral) so the row still renders.
 *
 * Q-J responsive: DataTable wraps in `overflow-x-auto` so the table scrolls
 * horizontally on narrow viewports rather than wrapping into a broken grid.
 */
import Link from "next/link";
import { Plus } from "lucide-react";
import {
  DataTable,
  SectionShell,
  StatusDot,
  statusToneForState,
  humanizeState,
} from "@/components/ui/iap";
import type { DataTableColumn } from "@/components/ui/iap";
import { localeNameFromCode } from "@/lib/locale-utils";
import type { InAppPurchaseLocalization } from "@/types/iap-management/apple";

export interface IapLocalizationSectionProps {
  localizations: readonly InAppPurchaseLocalization[];
  /** Edit page base href — `${editBaseHref}?locale=<code>` carries the
   *  selected locale to the edit form (Q-E navigate to specific locale). */
  editBaseHref: string;
}

const COLUMNS: readonly DataTableColumn<InAppPurchaseLocalization>[] = [
  {
    key: "locale",
    header: "Localizations",
    className: "w-[26%]",
    render: () => null, // overridden below
  },
  {
    key: "name",
    header: "Display Name",
    className: "w-[28%]",
    render: () => null,
  },
  {
    key: "description",
    header: "Description",
    render: () => null,
  },
  {
    key: "status",
    header: "Status",
    className: "w-[18%]",
    render: () => null,
  },
];

export function IapLocalizationSection({
  localizations,
  editBaseHref,
}: IapLocalizationSectionProps) {
  const columns: DataTableColumn<InAppPurchaseLocalization>[] = [
    {
      ...COLUMNS[0],
      render: (loc) => (
        <Link
          href={`${editBaseHref}?locale=${encodeURIComponent(loc.attributes.locale)}`}
          className="text-sm text-[#0071E3] hover:underline"
        >
          {localeNameFromCode(loc.attributes.locale)}
        </Link>
      ),
    },
    {
      ...COLUMNS[1],
      render: (loc) => (
        <span className="text-sm text-slate-900">{loc.attributes.name}</span>
      ),
    },
    {
      ...COLUMNS[2],
      render: (loc) => (
        <span
          className="block text-sm text-slate-600 truncate max-w-xs"
          title={loc.attributes.description ?? ""}
        >
          {loc.attributes.description ?? ""}
        </span>
      ),
    },
    {
      ...COLUMNS[3],
      render: (loc) => {
        const state = loc.attributes.state ?? "READY_TO_SUBMIT";
        return (
          <StatusDot
            tone={statusToneForState(state)}
            label={humanizeState(state)}
            size="sm"
          />
        );
      },
    },
  ];

  return (
    <SectionShell
      title="App Store Localization"
      titleAdornment={
        <span
          aria-label="Add localization via Edit"
          title="Edit to add a localization"
          className="text-slate-300"
        >
          <Plus className="h-4 w-4" aria-hidden />
        </span>
      }
      description={
        <>
          The localized display name for your in-app purchase will appear on
          the App Store. The localized description will appear on the App
          Store if you make your in-app purchase available for promotion.{" "}
          <a
            href="https://developer.apple.com/help/app-store-connect/manage-in-app-purchases/edit-in-app-purchase-information"
            target="_blank"
            rel="noreferrer"
            className="text-[#0071E3] hover:underline"
          >
            Learn More
          </a>
        </>
      }
      flushBody
    >
      <div className="overflow-x-auto">
        <DataTable
          columns={columns}
          rows={localizations}
          rowKey={(loc) => loc.id}
          emptyState="No localizations on Apple. Use Edit to add display names + descriptions."
        />
      </div>
    </SectionShell>
  );
}
