/**
 * IAP.p2.c — Header section of the View Detail page.
 *
 * Renders Apple's canonical IAP attributes per the mockup:
 *   - Status row (Q-D dot + label) + type badge + "Real-time as of …"
 *   - 2-col grid (md+, Q-J): Product ID, Apple ID, Reference Name, Type
 *
 * Server-renderable — no interactivity. Composes the p2.b primitives
 * (StatusDot, LabeledField, tooltips). Edit affordances live above the
 * section in the page chrome (Q-A defers inline edit; "Edit" button on
 * the page lands in IAP.p3).
 */
import { StatusDot, statusToneForState, humanizeState, LabeledField } from "@/components/ui/iap";
import { tooltipFor } from "@/lib/iap-management/tooltips";
import type {
  InAppPurchase,
  InAppPurchaseType,
} from "@/types/iap-management/apple";

const TYPE_LABEL: Record<InAppPurchaseType, string> = {
  CONSUMABLE: "Consumable",
  NON_CONSUMABLE: "Non-Consumable",
  NON_RENEWING_SUBSCRIPTION: "Non-Renewing Subscription",
};

const TYPE_BADGE: Record<InAppPurchaseType, string> = {
  CONSUMABLE: "bg-blue-50 text-blue-700 border-blue-200",
  NON_CONSUMABLE: "bg-purple-50 text-purple-700 border-purple-200",
  NON_RENEWING_SUBSCRIPTION: "bg-orange-50 text-orange-700 border-orange-200",
};

/** Apple's documented IAP name max length. Used for the "X / 64" counter
 *  rendered next to the Reference Name. */
export const IAP_NAME_MAX = 64;

export interface IapHeaderSectionProps {
  iap: InAppPurchase;
  /** Server-captured ISO timestamp for the "Real-time as of …" line. */
  fetchedAt: string;
}

export function IapHeaderSection({ iap, fetchedAt }: IapHeaderSectionProps) {
  const { attributes, id: appleId } = iap;
  const type = attributes.inAppPurchaseType;
  const state = attributes.state;
  const nameLen = attributes.name?.length ?? 0;
  const fetchedAtLabel = new Date(fetchedAt).toLocaleString();

  return (
    <section className="bg-white rounded-xl border border-slate-200 p-6">
      {/* Status row */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        <StatusDot
          tone={statusToneForState(state)}
          label={humanizeState(state)}
          size="md"
        />
        <span className="text-slate-300" aria-hidden>
          ·
        </span>
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${TYPE_BADGE[type]}`}
        >
          {TYPE_LABEL[type]}
        </span>
        <span className="ml-auto text-[11px] text-slate-400">
          Real-time as of{" "}
          <span className="font-medium text-slate-600">{fetchedAtLabel}</span>
        </span>
      </div>

      {/* 2-col grid (Q-J: md+ two-col, stack below md) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
        <LabeledField label="Product ID" tip={tooltipFor("product-id")}>
          <span className="font-mono">{attributes.productId}</span>
        </LabeledField>

        <LabeledField label="Apple ID" tip={tooltipFor("apple-id")}>
          <span className="font-mono text-slate-700">{appleId}</span>
        </LabeledField>

        <LabeledField
          label="Reference Name"
          tip={tooltipFor("reference-name")}
          hint={`${nameLen} / ${IAP_NAME_MAX}`}
        >
          {attributes.name}
        </LabeledField>

        <LabeledField label="Type" tip={tooltipFor("type")}>
          {TYPE_LABEL[type]}
        </LabeledField>
      </div>
    </section>
  );
}
