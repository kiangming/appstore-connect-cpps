// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { IapDetailView } from "./IapDetailView";
import type {
  InAppPurchase,
  InAppPurchaseLocalization,
  InAppPurchaseAppStoreReviewScreenshot,
} from "@/types/iap-management/apple";
import type { PriceScheduleView } from "@/lib/iap-management/queries/iap-detail";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeIap(): InAppPurchase {
  return {
    type: "inAppPurchases",
    id: "6770571764",
    attributes: {
      name: "Tool product 0000018",
      productId: "com.vngg.tool.product0000018",
      inAppPurchaseType: "CONSUMABLE",
      state: "MISSING_METADATA",
      reviewNote: "Launch app and tap Upgrade on home.",
    },
  };
}

function makeLocalizations(): InAppPurchaseLocalization[] {
  return [
    {
      type: "inAppPurchaseLocalizations",
      id: "l1",
      attributes: {
        locale: "en-US",
        name: "Tool product",
        description: "Desc en-US",
        state: "PREPARE_FOR_SUBMISSION",
      },
    },
  ];
}

function makeSchedule(): PriceScheduleView {
  return {
    baseTerritory: "USA",
    basePrice: null,
    entries: [
      {
        priceId: "p1",
        startDate: null,
        endDate: null,
        territory: "USA",
        customerPrice: "0.99",
        currency: "USD",
      },
    ],
  };
}

function makeScreenshot(): InAppPurchaseAppStoreReviewScreenshot {
  return {
    type: "inAppPurchaseAppStoreReviewScreenshots",
    id: "ss-1",
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
  };
}

const BASE_PROPS = {
  appAppleId: "1234",
  appName: "Tool App",
  internalIapId: "internal-iap-1",
  fetchedAt: "2026-05-20T09:14:00.000Z",
};

describe("IapDetailView composition", () => {
  it("renders all 4 sections when full data is present", () => {
    render(
      <IapDetailView
        {...BASE_PROPS}
        iap={makeIap()}
        localizations={makeLocalizations()}
        screenshot={makeScreenshot()}
        priceSchedule={makeSchedule()}
        priceScheduleError={null}
      />,
    );
    // p2.c — Header
    expect(screen.getByText("com.vngg.tool.product0000018")).toBeInTheDocument();
    // p2.d — Price Schedule
    expect(screen.getByText("Price Schedule")).toBeInTheDocument();
    // p2.e — Localization
    expect(screen.getByText("App Store Localization")).toBeInTheDocument();
    // p2.f — Review Information
    expect(screen.getByText("Review Information")).toBeInTheDocument();
  });

  it("renders price-schedule error notice without breaking other sections", () => {
    render(
      <IapDetailView
        {...BASE_PROPS}
        iap={makeIap()}
        localizations={makeLocalizations()}
        screenshot={null}
        priceSchedule={null}
        priceScheduleError="Apple 500"
      />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // Other sections still rendered.
    expect(screen.getByText("App Store Localization")).toBeInTheDocument();
    expect(screen.getByText("Review Information")).toBeInTheDocument();
  });

  it("renders the sticky action bar with Refresh + Apple Connect + Edit", () => {
    render(
      <IapDetailView
        {...BASE_PROPS}
        iap={makeIap()}
        localizations={[]}
        screenshot={null}
        priceSchedule={null}
        priceScheduleError={null}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Refresh from Apple/i }),
    ).toBeInTheDocument();

    const apple = screen.getByRole("link", { name: /View on Apple Connect/i });
    expect(apple).toHaveAttribute(
      "href",
      "https://appstoreconnect.apple.com/apps/1234/inappPurchases/6770571764",
    );
    expect(apple).toHaveAttribute("target", "_blank");

    const edit = screen.getByRole("link", { name: /^Edit$/ });
    expect(edit).toHaveAttribute(
      "href",
      "/iap-management/apps/1234/iaps/internal-iap-1",
    );
  });

  it("threads internalIapId into the Localization edit links", () => {
    render(
      <IapDetailView
        {...BASE_PROPS}
        iap={makeIap()}
        localizations={makeLocalizations()}
        screenshot={null}
        priceSchedule={null}
        priceScheduleError={null}
      />,
    );
    const localeLink = screen.getByRole("link", { name: /English \(U\.S\.\)/i });
    expect(localeLink).toHaveAttribute(
      "href",
      "/iap-management/apps/1234/iaps/internal-iap-1?locale=en-US",
    );
  });

  it("threads reviewNote from the IAP attributes into the Review Information section", () => {
    render(
      <IapDetailView
        {...BASE_PROPS}
        iap={makeIap()}
        localizations={[]}
        screenshot={null}
        priceSchedule={null}
        priceScheduleError={null}
      />,
    );
    expect(
      screen.getByText("Launch app and tap Upgrade on home."),
    ).toBeInTheDocument();
  });

  it("renders the back link with the app name", () => {
    render(
      <IapDetailView
        {...BASE_PROPS}
        iap={makeIap()}
        localizations={[]}
        screenshot={null}
        priceSchedule={null}
        priceScheduleError={null}
      />,
    );
    const back = screen.getByRole("link", { name: /IAPs · Tool App/i });
    expect(back).toHaveAttribute("href", "/iap-management/apps/1234");
  });
});
