// @vitest-environment jsdom

/**
 * IapListClient — empty vs. error vs. populated states.
 *
 * The >293-item bug rendered the "No IAPs cached yet" empty state when the
 * server read actually FAILED. This locks the distinction: loadError shows an
 * error state, a genuinely empty app shows the empty state, and items render.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { IapListClient } from "./IapListClient";
import type { IapWithDefaultLocale } from "@/lib/google-iap-management/repository/iaps";

function iap(sku: string): IapWithDefaultLocale {
  return {
    id: `id-${sku}`,
    app_id: "app-1",
    sku,
    purchase_type: "managed",
    status: "active",
    default_currency: "USD",
    default_price_micros: "990000",
    last_synced_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    default_title: `${sku} title`,
  };
}

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
