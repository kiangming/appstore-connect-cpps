// @vitest-environment jsdom

/**
 * IAP.p2.h — IAP View Detail end-to-end integration.
 *
 * Wires the real `getIapViewData` composer (with mocked Apple HTTP at the
 * client layer) into the real `IapDetailView` so the full chain — JSON:API
 * unpack → view-model → composed sections — is exercised in a single test.
 *
 * The unit tests in `lib/iap-management/queries/iap-detail.test.ts` already
 * cover the composer in isolation; the section-level tests cover the views
 * in isolation. This file pins the contract between them — a bad assumption
 * at either layer would let those isolated tests pass while the page broke.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const getInAppPurchase = vi.hoisted(() => vi.fn());
const getPriceScheduleForIap = vi.hoisted(() => vi.fn());

vi.mock("@/lib/iap-management/apple/client", () => ({ getInAppPurchase }));
vi.mock("@/lib/iap-management/apple/price-schedules", () => ({
  getPriceScheduleForIap,
}));
vi.mock("@/lib/iap-management/apple/fetch", () => ({
  AppleApiError: class extends Error {
    status: number;
    body: string;
    constructor(status: number, _m: string, _e: string, body: string) {
      super(body);
      this.status = status;
      this.body = body;
    }
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { getIapViewData } from "@/lib/iap-management/queries/iap-detail";
import { IapDetailView } from "./IapDetailView";
import { AppleApiError } from "@/lib/iap-management/apple/fetch";
import type {
  AscApiResponse,
  InAppPurchase,
  InAppPurchasePriceSchedule,
} from "@/types/iap-management/apple";

const CREDS = {
  id: "test",
  name: "Test",
  keyId: "K",
  issuerId: "I",
  privateKey: "P",
};

const APPLE_IAP_ID = "6770571764";
const APP_APPLE_ID = "1234";
const INTERNAL_IAP_ID = "internal-iap-1";

function fullIapResponse(): AscApiResponse<InAppPurchase> {
  return {
    data: {
      type: "inAppPurchases",
      id: APPLE_IAP_ID,
      attributes: {
        name: "Tool product 0000018",
        productId: "com.vngg.tool.product0000018",
        inAppPurchaseType: "CONSUMABLE",
        state: "MISSING_METADATA",
        reviewNote: "Tap Upgrade on the home screen.",
      },
    },
    included: [
      {
        type: "inAppPurchaseLocalizations",
        id: "loc-en-US",
        attributes: {
          locale: "en-US",
          name: "Test tool product 000005",
          description: "Description en-US",
          state: "PREPARE_FOR_SUBMISSION",
        },
      },
      {
        type: "inAppPurchaseLocalizations",
        id: "loc-en-GB",
        attributes: {
          locale: "en-GB",
          name: "Test tool EN UK product",
          description: "Description en-GB",
          state: "READY_FOR_SALE",
        },
      },
      {
        type: "inAppPurchaseAppStoreReviewScreenshots",
        id: "scr-1",
        attributes: {
          fileName: "review-iphone-67.png",
          fileSize: 1024,
          imageAsset: {
            width: 1290,
            height: 2796,
            url: "https://example.com/full.png",
            templateUrl: "https://example.com/{w}x{h}/{f}/abc",
          },
        },
      },
    ],
  };
}

/**
 * IAP.p2.l: schedule fixture mirrors Apple's actual JSON:API shape
 * (iris-API ground truth at MV30):
 *   - InAppPurchasePrice carries its OWN `relationships.territory`
 *   - Territory resources carry `attributes.currency`
 *   - InAppPurchasePricePoints have NO `currency` (Territory attribute)
 *   - Base territory price IS in manualPrices (not in a separate bucket)
 */
function priceScheduleFetchResult(): AscApiResponse<InAppPurchasePriceSchedule> {
  return {
    data: {
      type: "inAppPurchasePriceSchedules",
      id: "sched-1",
      attributes: {},
      relationships: {
        baseTerritory: { data: { type: "territories", id: "USA" } },
        manualPrices: {
          data: [
            { type: "inAppPurchasePrices", id: "p-usa" },
            { type: "inAppPurchasePrices", id: "p-vn" },
          ],
        },
      },
    } as unknown as InAppPurchasePriceSchedule,
    included: [
      // Base USA row (matches Apple's iris response — base lives WITHIN manualPrices).
      {
        type: "inAppPurchasePrices",
        id: "p-usa",
        attributes: { startDate: null },
        relationships: {
          inAppPurchasePricePoint: {
            data: { type: "inAppPurchasePricePoints", id: "pp-usa" },
          },
          territory: { data: { type: "territories", id: "USA" } },
        },
      },
      {
        type: "inAppPurchasePricePoints",
        id: "pp-usa",
        attributes: { customerPrice: "0.99", proceeds: "0.7" },
      },
      {
        type: "territories",
        id: "USA",
        attributes: { currency: "USD" },
      },
      // VNM override.
      {
        type: "inAppPurchasePrices",
        id: "p-vn",
        attributes: { startDate: null },
        relationships: {
          inAppPurchasePricePoint: {
            data: { type: "inAppPurchasePricePoints", id: "pp-vn" },
          },
          territory: { data: { type: "territories", id: "VNM" } },
        },
      },
      {
        type: "inAppPurchasePricePoints",
        id: "pp-vn",
        attributes: { customerPrice: "89000", proceeds: "62300" },
      },
      {
        type: "territories",
        id: "VNM",
        attributes: { currency: "VND" },
      },
    ],
  };
}

async function renderPage(): Promise<void> {
  const view = await getIapViewData(CREDS, APPLE_IAP_ID);
  render(
    <IapDetailView
      appAppleId={APP_APPLE_ID}
      appName="Tool App"
      internalIapId={INTERNAL_IAP_ID}
      iap={view.iap}
      localizations={view.localizations}
      screenshot={view.screenshot}
      priceSchedule={view.priceSchedule}
      priceScheduleError={view.priceScheduleError}
      fetchedAt="2026-05-20T09:14:00.000Z"
    />,
  );
}

describe("IAP View Detail — integration", () => {
  beforeEach(() => {
    getInAppPurchase.mockReset();
    getPriceScheduleForIap.mockReset();
  });

  it("renders all 4 sections end-to-end with full Apple data", async () => {
    getInAppPurchase.mockResolvedValueOnce(fullIapResponse());
    getPriceScheduleForIap.mockResolvedValueOnce(priceScheduleFetchResult());

    await renderPage();

    // Header
    expect(
      screen.getByText("com.vngg.tool.product0000018"),
    ).toBeInTheDocument();
    // Price Schedule
    expect(screen.getByText("Price Schedule")).toBeInTheDocument();
    expect(screen.getByText("United States")).toBeInTheDocument();
    // Localization — 2 rows, both locales rendered as links
    expect(
      screen.getByRole("link", { name: /English \(U\.S\.\)/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /English \(U\.K\.\)/i }),
    ).toBeInTheDocument();
    // Review Information — screenshot + notes
    expect(
      screen.getByText("review-iphone-67.png"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Tap Upgrade on the home screen."),
    ).toBeInTheDocument();
  });

  it("renders Localization empty state when Apple returns no localizations", async () => {
    const res = fullIapResponse();
    res.included = res.included!.filter(
      (r) => r.type !== "inAppPurchaseLocalizations",
    );
    getInAppPurchase.mockResolvedValueOnce(res);
    getPriceScheduleForIap.mockResolvedValueOnce(priceScheduleFetchResult());

    await renderPage();
    expect(
      screen.getByText(/No localizations on Apple/i),
    ).toBeInTheDocument();
  });

  it("renders Review Information empty state when Apple returns no screenshot", async () => {
    const res = fullIapResponse();
    res.included = res.included!.filter(
      (r) => r.type !== "inAppPurchaseAppStoreReviewScreenshots",
    );
    getInAppPurchase.mockResolvedValueOnce(res);
    getPriceScheduleForIap.mockResolvedValueOnce(priceScheduleFetchResult());

    await renderPage();
    expect(screen.getByText("No screenshot on Apple.")).toBeInTheDocument();
  });

  it("renders Price Schedule empty placeholder on Apple 404 (no schedule yet)", async () => {
    getInAppPurchase.mockResolvedValueOnce(fullIapResponse());
    getPriceScheduleForIap.mockRejectedValueOnce(
      new AppleApiError(
        404,
        "GET",
        "/v2/.../inAppPurchasePriceSchedule",
        "",
      ),
    );

    await renderPage();
    expect(
      screen.getByText(/No pricing has been set on Apple yet/i),
    ).toBeInTheDocument();
    // Other sections still render
    expect(screen.getByText("App Store Localization")).toBeInTheDocument();
  });

  it("renders Price Schedule error notice on non-404 Apple failure", async () => {
    getInAppPurchase.mockResolvedValueOnce(fullIapResponse());
    getPriceScheduleForIap.mockRejectedValueOnce(
      new AppleApiError(
        500,
        "GET",
        "/v2/.../inAppPurchasePriceSchedule",
        "internal boom",
      ),
    );

    await renderPage();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/internal boom/i)).toBeInTheDocument();
    // Other sections still render
    expect(screen.getByText("App Store Localization")).toBeInTheDocument();
    expect(screen.getByText("Review Information")).toBeInTheDocument();
  });

  it("renders all 5 Q-D status states across localizations without crashing", async () => {
    const res = fullIapResponse();
    res.included = [
      ...res.included!.filter(
        (r) => r.type !== "inAppPurchaseLocalizations",
      ),
      // success / warning / info / error / neutral
      {
        type: "inAppPurchaseLocalizations",
        id: "l-success",
        attributes: { locale: "en-US", name: "a", state: "READY_FOR_SALE" },
      },
      {
        type: "inAppPurchaseLocalizations",
        id: "l-warning",
        attributes: { locale: "vi", name: "b", state: "MISSING_METADATA" },
      },
      {
        type: "inAppPurchaseLocalizations",
        id: "l-info",
        attributes: { locale: "ja", name: "c", state: "WAITING_FOR_REVIEW" },
      },
      {
        type: "inAppPurchaseLocalizations",
        id: "l-error",
        attributes: { locale: "ko", name: "d", state: "REJECTED" },
      },
      {
        type: "inAppPurchaseLocalizations",
        id: "l-neutral",
        attributes: { locale: "th", name: "e", state: "READY_TO_SUBMIT" },
      },
    ];
    getInAppPurchase.mockResolvedValueOnce(res);
    getPriceScheduleForIap.mockResolvedValueOnce(priceScheduleFetchResult());

    const { container } = await (async () => {
      const view = await getIapViewData(CREDS, APPLE_IAP_ID);
      return render(
        <IapDetailView
          appAppleId={APP_APPLE_ID}
          appName="Tool App"
          internalIapId={INTERNAL_IAP_ID}
          iap={view.iap}
          localizations={view.localizations}
          screenshot={view.screenshot}
          priceSchedule={view.priceSchedule}
          priceScheduleError={view.priceScheduleError}
          fetchedAt="2026-05-20T09:14:00.000Z"
        />,
      );
    })();

    // 5 localization rows → 5 status dots inside the table.
    const localizationSection = screen
      .getByText("App Store Localization")
      .closest("section");
    expect(localizationSection).not.toBeNull();
    const dots = localizationSection!.querySelectorAll(
      "span[aria-hidden].rounded-full",
    );
    expect(dots.length).toBe(5);
    expect([...dots].map((d) => d.className)).toEqual([
      expect.stringContaining("bg-emerald-500"),
      expect.stringContaining("bg-amber-500"),
      expect.stringContaining("bg-blue-500"),
      expect.stringContaining("bg-red-500"),
      expect.stringContaining("bg-slate-400"),
    ]);
    // sanity — referenced container variable in case future linters add unused
    expect(container).toBeTruthy();
  });

  it("renders the Apple Connect deep link with the correct path", async () => {
    getInAppPurchase.mockResolvedValueOnce(fullIapResponse());
    getPriceScheduleForIap.mockResolvedValueOnce(priceScheduleFetchResult());

    await renderPage();
    const link = screen.getByRole("link", { name: /View on Apple Connect/i });
    expect(link).toHaveAttribute(
      "href",
      `https://appstoreconnect.apple.com/apps/${APP_APPLE_ID}/inappPurchases/${APPLE_IAP_ID}`,
    );
  });
});
