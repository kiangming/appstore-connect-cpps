// @vitest-environment jsdom

/**
 * Confirms the toggle's initial UI state reflects the persisted `enabled`
 * value from the server (not a default), and that saving with a blank
 * token still submits the CURRENT toggle state rather than silently
 * defaulting it to false — mirrors the Apple settings/hub-tracking test.
 * (No isAdmin prop here — this page hard-redirects non-admins server-side,
 * unlike Apple's member-visible read-only render.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { HubTrackingClient } from "./HubTrackingClient";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        workflow_id: "wf",
        configured: true,
        enabled: true,
        updated_at: "2026-07-01T00:00:00.000Z",
        validation: { ok: true },
      }),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function toggle(): HTMLInputElement {
  return screen.getByRole("checkbox") as HTMLInputElement;
}

describe("HubTrackingClient (Google) — enabled toggle reflects persisted state, not a default", () => {
  it("checks the toggle on mount when the persisted config has enabled=true", () => {
    render(
      <HubTrackingClient
        initialConfig={{
          workflow_id: "wf",
          configured: true,
          enabled: true,
          updated_at: "2026-07-01T00:00:00.000Z",
        }}
      />,
    );
    expect(toggle().checked).toBe(true);
  });

  it("leaves the toggle unchecked on mount when the persisted config has enabled=false", () => {
    render(
      <HubTrackingClient
        initialConfig={{
          workflow_id: "wf",
          configured: true,
          enabled: false,
          updated_at: "2026-07-01T00:00:00.000Z",
        }}
      />,
    );
    expect(toggle().checked).toBe(false);
  });

  it("saving with the token field left BLANK still submits enabled=true — no silent reset to false", async () => {
    render(
      <HubTrackingClient
        initialConfig={{
          workflow_id: "wf",
          configured: true,
          enabled: true,
          updated_at: "2026-07-01T00:00:00.000Z",
        }}
      />,
    );
    expect(toggle().checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Save/ }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.enabled).toBe(true);
    expect(body).not.toHaveProperty("token");
  });
});
