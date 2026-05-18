/**
 * IAP.p2.b — coloured status dot + optional label.
 *
 * Q-D 5-colour palette (simplified from Apple's full enum):
 *   - success (green)  : READY_FOR_SALE, APPROVED
 *   - warning (amber)  : MISSING_METADATA
 *   - info    (blue)   : WAITING_FOR_REVIEW, IN_REVIEW, PENDING_*
 *   - error   (red)    : REJECTED, DEVELOPER_ACTION_NEEDED
 *   - neutral (slate)  : READY_TO_SUBMIT, REMOVED_FROM_SALE, *REMOVED_FROM_SALE
 *
 * Server-renderable — no client interactivity. Used in the header status
 * row and the per-locale table rows.
 */
import type { InAppPurchaseState } from "@/types/iap-management/apple";

export type StatusTone = "success" | "warning" | "info" | "error" | "neutral";

const DOT_COLOR: Record<StatusTone, string> = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  info: "bg-blue-500",
  error: "bg-red-500",
  neutral: "bg-slate-400",
};

const SIZE: Record<NonNullable<StatusDotProps["size"]>, string> = {
  sm: "h-2 w-2",
  md: "h-2.5 w-2.5",
};

export interface StatusDotProps {
  tone: StatusTone;
  /** Optional inline label. When omitted the dot renders alone. */
  label?: string;
  size?: "sm" | "md";
  className?: string;
}

export function StatusDot({
  tone,
  label,
  size = "sm",
  className = "",
}: StatusDotProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span
        aria-hidden
        className={`inline-block rounded-full ${SIZE[size]} ${DOT_COLOR[tone]}`}
      />
      {label && (
        <span className="text-xs font-medium text-slate-700">{label}</span>
      )}
    </span>
  );
}

/**
 * Resolve a raw Apple state string to the 5-colour Q-D tone bucket. Accepts
 * any string so locale-specific states (which Apple sometimes returns
 * unexpectedly) fall through to `neutral` instead of throwing.
 */
export function statusToneForState(state: string | InAppPurchaseState): StatusTone {
  switch (state) {
    case "READY_FOR_SALE":
    case "APPROVED":
      return "success";
    case "MISSING_METADATA":
    case "PREPARE_FOR_SUBMISSION":
      return "warning";
    case "WAITING_FOR_REVIEW":
    case "IN_REVIEW":
    case "PENDING_APPLE_RELEASE":
    case "PENDING_DEVELOPER_RELEASE":
      return "info";
    case "REJECTED":
    case "DEVELOPER_ACTION_NEEDED":
      return "error";
    default:
      return "neutral";
  }
}

/** Convert SCREAMING_SNAKE state to Title Case for display. */
export function humanizeState(state: string): string {
  return state
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
