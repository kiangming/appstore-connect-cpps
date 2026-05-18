// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  IapReviewInfoSection,
  REVIEW_NOTE_MAX,
} from "./IapReviewInfoSection";
import type { InAppPurchaseAppStoreReviewScreenshot } from "@/types/iap-management/apple";

function makeScreenshot(
  attrs: Partial<InAppPurchaseAppStoreReviewScreenshot["attributes"]> = {},
): InAppPurchaseAppStoreReviewScreenshot {
  return {
    type: "inAppPurchaseAppStoreReviewScreenshots",
    id: "ss-1",
    attributes: {
      fileName: "review-iphone-67.png",
      fileSize: 123456,
      imageAsset: {
        width: 1290,
        height: 2796,
        url: "https://example.com/full.png",
        templateUrl:
          "https://example.com/{w}x{h}/{f}/abc",
      },
      ...attrs,
    },
  };
}

describe("IapReviewInfoSection", () => {
  it("renders title + helper text", () => {
    render(<IapReviewInfoSection screenshot={null} reviewNote={null} />);
    expect(screen.getByText("Review Information")).toBeInTheDocument();
    expect(
      screen.getByText(/reviewer needs to see what the in-app purchase/i),
    ).toBeInTheDocument();
  });

  it("renders the screenshot thumbnail + filename + dimensions metaLine when present", () => {
    render(
      <IapReviewInfoSection
        screenshot={makeScreenshot()}
        reviewNote={null}
      />,
    );
    const img = screen.getByAltText("review-iphone-67.png") as HTMLImageElement;
    expect(img.src).toContain("390x844/png/abc");
    expect(screen.getByText("review-iphone-67.png")).toBeInTheDocument();
    expect(screen.getByText("1290 × 2796")).toBeInTheDocument();
  });

  it("falls back to the empty-state placeholder when no screenshot is present", () => {
    render(<IapReviewInfoSection screenshot={null} reviewNote="Notes" />);
    expect(screen.getByText("No screenshot on Apple.")).toBeInTheDocument();
  });

  it("renders the review-notes block + counter when notes are present", () => {
    render(
      <IapReviewInfoSection
        screenshot={null}
        reviewNote="Launch app, tap Upgrade."
      />,
    );
    expect(
      screen.getByText("Launch app, tap Upgrade."),
    ).toBeInTheDocument();
    // "Launch app, tap Upgrade." → 24 chars
    expect(
      screen.getByText(`24 / ${REVIEW_NOTE_MAX}`),
    ).toBeInTheDocument();
  });

  it("renders the notes empty-state + 0-char counter when reviewNote is missing", () => {
    render(<IapReviewInfoSection screenshot={null} reviewNote={null} />);
    expect(
      screen.getByText("No review notes on Apple."),
    ).toBeInTheDocument();
    expect(screen.getByText(`0 / ${REVIEW_NOTE_MAX}`)).toBeInTheDocument();
  });

  it("preserves line breaks in the review notes (whitespace-pre-wrap)", () => {
    const multi = "Line 1\nLine 2";
    const { container } = render(
      <IapReviewInfoSection screenshot={null} reviewNote={multi} />,
    );
    const block = container.querySelector(".whitespace-pre-wrap");
    expect(block?.textContent).toBe(multi);
  });

  it("renders tooltip badges for both columns", () => {
    render(<IapReviewInfoSection screenshot={null} reviewNote={null} />);
    expect(screen.getAllByRole("tooltip")).toHaveLength(2);
  });
});
