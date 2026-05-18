/**
 * IAP.p2.b — barrel export for the View Detail UI primitives.
 *
 * Keeps consumer imports tidy:
 *   import { StatusDot, SectionShell, DataTable } from "@/components/ui/iap";
 */
export { StatusDot, statusToneForState, humanizeState } from "./StatusDot";
export type { StatusTone, StatusDotProps } from "./StatusDot";

export { TooltipBadge } from "./TooltipBadge";
export type { TooltipBadgeProps } from "./TooltipBadge";

export { LabeledField } from "./LabeledField";
export type { LabeledFieldProps } from "./LabeledField";

export { SectionShell } from "./SectionShell";
export type { SectionShellProps } from "./SectionShell";

export { DataTable } from "./DataTable";
export type { DataTableColumn, DataTableProps } from "./DataTable";

export { ExpandablePanel } from "./ExpandablePanel";
export type { ExpandablePanelProps } from "./ExpandablePanel";

export { ScreenshotPreview } from "./ScreenshotPreview";
export type { ScreenshotPreviewProps } from "./ScreenshotPreview";
