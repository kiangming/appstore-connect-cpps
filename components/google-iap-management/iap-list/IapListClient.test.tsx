// @vitest-environment jsdom

/**
 * IapListClient — empty vs. error vs. populated states.
 *
 * The >293-item bug rendered the "No IAPs cached yet" empty state when the
 * server read actually FAILED. This locks the distinction: loadError shows an
 * error state, a genuinely empty app shows the empty state, and items render.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { IapListClient } from "./IapListClient";
import type { IapWithDefaultLocale } from "@/lib/google-iap-management/repository/iaps";

function iap(
  sku: string,
  overrides: Partial<IapWithDefaultLocale> = {},
): IapWithDefaultLocale {
  return {
    id: `id-${sku}`,
    app_id: "app-1",
    sku,
    purchase_type: "managed",
    status: "active",
    default_currency: "USD",
    default_price_micros: "990000",
    last_synced_at: null,
    deleted_on_google_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    default_title: `${sku} title`,
    ...overrides,
  };
}
const flagged = (sku: string) =>
  iap(sku, { deleted_on_google_at: "2026-07-02T00:00:00Z" });

function renderList(extra: Partial<Parameters<typeof IapListClient>[0]> = {}) {
  render(
    <IapListClient
      packageName="com.x"
      appDisplayName="X"
      appLastSyncedAt={null}
      initialIaps={[]}
      {...extra}
    />,
  );
}

describe("IapListClient — load error vs. empty", () => {
  it("loadError → shows the error state, NOT the empty state", () => {
    renderList({ loadError: true, initialIaps: [] });
    expect(screen.getByText(/Failed to load IAPs/i)).toBeInTheDocument();
    expect(screen.queryByText(/No IAPs cached yet/i)).not.toBeInTheDocument();
  });

  it("genuinely empty app (no error) → shows the empty state", () => {
    renderList({ loadError: false, initialIaps: [] });
    expect(screen.getByText(/No IAPs cached yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/Failed to load IAPs/i)).not.toBeInTheDocument();
  });

  it("populated list renders items and neither empty nor error state", () => {
    renderList({ initialIaps: [iap("coins.a"), iap("coins.b")] });
    expect(screen.getByText("coins.a title")).toBeInTheDocument();
    expect(screen.getByText("coins.b title")).toBeInTheDocument();
    expect(screen.queryByText(/No IAPs cached yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Failed to load IAPs/i)).not.toBeInTheDocument();
  });
});

describe("IapListClient — deleted-on-Google flagging", () => {
  it("no flagged items → no warning banner, no count chip", () => {
    renderList({ initialIaps: [iap("live.a")] });
    expect(screen.queryByText(/no longer on Google Play/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not on Google/i)).not.toBeInTheDocument();
  });

  it("flagged items → amber banner with count + 'not on Google' chip", () => {
    renderList({ initialIaps: [iap("live.a"), flagged("gone.b"), flagged("gone.c")] });
    expect(screen.getByText(/2 items exist in the tool.+no longer on Google Play/i)).toBeInTheDocument();
    expect(screen.getByText(/2 not on Google/i)).toBeInTheDocument();
    // Live count chip reflects only live items.
    expect(screen.getByText(/1 on Google Play/i)).toBeInTheDocument();
  });

  it("flagged rows render in the separate section with the Deleted pill + acknowledge action", () => {
    renderList({ initialIaps: [iap("live.a"), flagged("gone.b")] });
    expect(screen.getByText(/Not on Google Play · 1 item/i)).toBeInTheDocument();
    expect(screen.getByText(/Deleted on Google/i)).toBeInTheDocument();
    expect(screen.getByText(/Acknowledge \/ Remove/i)).toBeInTheDocument();
    // Live item is NOT struck-through / flagged.
    expect(screen.getByText("live.a title")).toBeInTheDocument();
  });

  it("filter chip toggles the flagged block; banner + count persist", () => {
    renderList({ initialIaps: [iap("live.a"), flagged("gone.b")] });
    // Shown by default.
    expect(screen.getByText(/Deleted on Google/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Hide deleted-on-Google/i }));
    // Flagged rows hidden; collapsed note shown; banner still present.
    expect(screen.queryByText(/Deleted on Google/i)).not.toBeInTheDocument();
    expect(screen.getByText(/1 deleted-on-Google item hidden/i)).toBeInTheDocument();
    expect(screen.getByText(/no longer on Google Play/i)).toBeInTheDocument();
  });

  it("per-row Acknowledge/Remove reveals the light confirm", () => {
    renderList({ initialIaps: [flagged("gone.b")] });
    fireEvent.click(screen.getByRole("button", { name: /Acknowledge \/ Remove/i }));
    expect(screen.getByText(/already gone from Google Play\. This cannot be undone/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Confirm remove/i })).toBeInTheDocument();
  });
});
