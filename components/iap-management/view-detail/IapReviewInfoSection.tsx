/**
 * IAP.p2.f — Review Information section of the View Detail page.
 *
 * Two-column grid (md+, Q-J): Screenshot left, Review Notes right.
 * Q-A view-only v1 → notes render as a read-only block; the character
 * counter ("X / 4000") matches Apple Connect's UX even though we're not
 * editing inline. Q-E enlarge modal is handled by ScreenshotPreview.
 *
 * Both columns have empty states so a partially-configured IAP (no
 * screenshot OR no notes) still renders symmetrically.
 *
 * Apple's `reviewNote` field is documented as `reviewNotes` in some places;
 * we accept the canonical `reviewNote` attribute (the one Apple returns on
 * GET /v1/inAppPurchases/{id}). Manager polished the helper-text + column
 * heights during mockup review — column wrappers below use `flex` to keep
 * heights matched when one column has content and the other is empty.
 */
import {
  SectionShell,
  LabeledField,
  ScreenshotPreview,
} from "@/components/ui/iap";
import { tooltipFor } from "@/lib/iap-management/tooltips";
import type { InAppPurchaseAppStoreReviewScreenshot } from "@/types/iap-management/apple";

/** Apple's documented review-note max length. Used by the counter. */
export const REVIEW_NOTE_MAX = 4000;

export interface IapReviewInfoSectionProps {
  screenshot: InAppPurchaseAppStoreReviewScreenshot | null;
  reviewNote?: string | null;
}

/** Resolve Apple's `templateUrl` to thumbnail + full-size URLs. */
function resolveUrls(
  screenshot: InAppPurchaseAppStoreReviewScreenshot | null,
): { thumbUrl?: string; fullUrl?: string; metaLine?: string } {
  const asset = screenshot?.attributes.imageAsset;
  if (!asset?.templateUrl) return {};
  const thumb = asset.templateUrl
    .replace("{w}", "390")
    .replace("{h}", "844")
    .replace("{f}", "png");
  const full = asset.templateUrl
    .replace("{w}", String(asset.width))
    .replace("{h}", String(asset.height))
    .replace("{f}", "png");
  const metaLine = `${asset.width} × ${asset.height}`;
  return { thumbUrl: thumb, fullUrl: full, metaLine };
}

export function IapReviewInfoSection({
  screenshot,
  reviewNote,
}: IapReviewInfoSectionProps) {
  const { thumbUrl, fullUrl, metaLine } = resolveUrls(screenshot);
  const notes = reviewNote ?? "";
  const notesLen = notes.length;

  return (
    <SectionShell
      title="Review Information"
      description="The reviewer needs to see what the in-app purchase looks like in your app, and any context that helps them complete review."
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Screenshot column */}
        <div className="flex flex-col">
          <LabeledField
            label="Screenshot"
            tip={tooltipFor("review-screenshot")}
          >
            {screenshot ? (
              <ScreenshotPreview
                thumbnailUrl={thumbUrl}
                fullUrl={fullUrl}
                fileName={screenshot.attributes.fileName}
                metaLine={metaLine}
              />
            ) : (
              <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-xs italic text-slate-400">
                No screenshot on Apple.
              </div>
            )}
          </LabeledField>
        </div>

        {/* Review Notes column */}
        <div className="flex flex-col">
          <LabeledField
            label="Review Notes (Optional)"
            tip={tooltipFor("review-notes")}
            hint={`${notesLen} / ${REVIEW_NOTE_MAX}`}
          >
            {notes ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700 min-h-[160px] whitespace-pre-wrap">
                {notes}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-xs italic text-slate-400 min-h-[160px] flex items-center justify-center">
                No review notes on Apple.
              </div>
            )}
          </LabeledField>
        </div>
      </div>
    </SectionShell>
  );
}
