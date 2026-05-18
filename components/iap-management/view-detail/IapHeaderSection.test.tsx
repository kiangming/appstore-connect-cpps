// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { IapHeaderSection, IAP_NAME_MAX } from "./IapHeaderSection";
import type { InAppPurchase } from "@/types/iap-management/apple";

function makeIap(overrides: Partial<InAppPurchase["attributes"]> = {}): InAppPurchase {
  return {
    type: "inAppPurchases",
    id: "6770571764",
    attributes: {
      name: "Tool product 0000018",
      productId: "com.vngg.tool.product0000018",
      inAppPurchaseType: "CONSUMABLE",
      state: "MISSING_METADATA",
      ...overrides,
    },
  };
}

describe("IapHeaderSection", () => {
  it("renders productId, apple id, name and type field", () => {
    render(
      <IapHeaderSection
        iap={makeIap()}
        fetchedAt="2026-05-20T09:14:00.000Z"
      />,
    );
    expect(screen.getByText("com.vngg.tool.product0000018")).toBeInTheDocument();
    expect(screen.getByText("6770571764")).toBeInTheDocument();
    expect(screen.getByText("Tool product 0000018")).toBeInTheDocument();
    // "Consumable" appears twice (badge + type field) — both are rendered.
    expect(screen.getAllByText("Consumable").length).toBeGreaterThanOrEqual(2);
  });

  it("renders the humanised state with the matching Q-D tone", () => {
    const { container } = render(
      <IapHeaderSection
        iap={makeIap({ state: "MISSING_METADATA" })}
        fetchedAt="2026-05-20T09:14:00.000Z"
      />,
    );
    expect(screen.getByText("Missing Metadata")).toBeInTheDocument();
    const dot = container.querySelector("span[aria-hidden].rounded-full");
    expect(dot?.className).toContain("bg-amber-500");
  });

  it("renders the character counter next to Reference Name", () => {
    render(
      <IapHeaderSection
        iap={makeIap({ name: "Tool product 0000018" })}
        fetchedAt="2026-05-20T09:14:00.000Z"
      />,
    );
    // "Tool product 0000018".length === 20
    const counter = screen.getByText(`20 / ${IAP_NAME_MAX}`);
    expect(counter).toBeInTheDocument();
  });

  it("uses the type-specific badge styling", () => {
    const { container } = render(
      <IapHeaderSection
        iap={makeIap({ inAppPurchaseType: "NON_CONSUMABLE" })}
        fetchedAt="2026-05-20T09:14:00.000Z"
      />,
    );
    const badge = container.querySelector(".bg-purple-50");
    expect(badge).toBeInTheDocument();
    expect(badge?.textContent).toContain("Non-Consumable");
  });

  it("formats the fetchedAt as a localised timestamp", () => {
    render(
      <IapHeaderSection
        iap={makeIap()}
        fetchedAt="2026-05-20T09:14:00.000Z"
      />,
    );
    // Locale-formatted timestamp — assert the "Real-time as of" framing is
    // present rather than pinning a specific locale string.
    expect(screen.getByText(/Real-time as of/)).toBeInTheDocument();
  });

  it("renders the tooltip badges for each labelled field (regression pin)", () => {
    render(
      <IapHeaderSection
        iap={makeIap()}
        fetchedAt="2026-05-20T09:14:00.000Z"
      />,
    );
    // Four LabeledFields → four tooltip popovers in the DOM.
    expect(screen.getAllByRole("tooltip")).toHaveLength(4);
  });
});
