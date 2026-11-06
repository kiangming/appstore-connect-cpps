// @vitest-environment jsdom
/**
 * G1 — the CPP editor checks a dropped screenshot against the TARGET set's
 * sizes, not the device's (arc `[CPP-bulkimport-ipad-screenshot-sizes]`,
 * Manager Q4). Before G1 the editor used the device-level iPad list (13" only),
 * so an 11" image dropped on an 11" set was refused and a 13" image dropped on
 * an 11" set was accepted.
 *
 * Real component, real `validateScreenshotForDisplayType`; the size comes from
 * the file name via the fake `Image`; only `fetch` is faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { AppCustomProductPageLocalization } from "@/types/asc";
import { LocalizationManager } from "./LocalizationManager";
import { installFakeImage } from "./__fixtures__/screenshot-files";

function installFetch(setType: string) {
  const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/asc/screenshot-sets?")) {
        return ok({
          data: [{ type: "appScreenshotSets", id: "set-1", attributes: { screenshotDisplayType: setType }, relationships: { appScreenshots: { data: [] } } }],
          included: [],
        });
      }
      if (url.startsWith("/api/asc/preview-sets?")) return ok({ data: [], included: [] });
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
}

async function dropOnIpadSet(setType: string, fileName: string) {
  installFetch(setType);
  render(
    <LocalizationManager
      cppId="cpp-1"
      versionId="v1"
      appId="app-1"
      initialLocalizations={[
        { type: "appCustomProductPageLocalizations", id: "loc-en-0000", attributes: { locale: "en-US" } } as unknown as AppCustomProductPageLocalization,
      ]}
    />,
  );
  fireEvent.click(screen.getByText("loc-en-0…").closest("button") as HTMLElement);
  // The iPad tab shows the set's label from the spec table.
  const ipadTab = (await screen.findAllByText("iPad"))[0].closest("button") as HTMLElement;
  fireEvent.click(ipadTab);
  const zone = (await screen.findAllByText("Drop screenshots or click to browse"))[0].closest("div.border-dashed") as HTMLElement;
  fireEvent.drop(zone, { dataTransfer: { files: [new File(["x"], fileName, { type: "image/png" })] } });
}

beforeEach(() => installFakeImage());
afterEach(() => vi.unstubAllGlobals());

describe("editor — check against the TARGET set", () => {
  it("11\" image on the 11\" set ⇒ staged", async () => {
    await dropOnIpadSet("APP_IPAD_PRO_3GEN_11", "a-1668x2388.png");
    expect(await screen.findByText("a-1668x2388.png")).toBeInTheDocument();
    expect(screen.queryByText(/❌/)).toBeNull();
  });

  it("13\" image on the 11\" set ⇒ refused, names the image's real group", async () => {
    await dropOnIpadSet("APP_IPAD_PRO_3GEN_11", "b-2064x2752.png");
    expect(await screen.findByText("❌ b-2064x2752.png")).toBeInTheDocument();
    expect(screen.getByText(/this is an iPad 13" size, not iPad 11"/)).toBeInTheDocument();
  });

  it("13\" image on the 13\" set ⇒ staged (parity)", async () => {
    await dropOnIpadSet("APP_IPAD_PRO_3GEN_129", "c-2064x2752.png");
    expect(await screen.findByText("c-2064x2752.png")).toBeInTheDocument();
  });

  it("11\" image on the 13\" set ⇒ refused with today's sentence + the hint", async () => {
    await dropOnIpadSet("APP_IPAD_PRO_3GEN_129", "d-1668x2388.png");
    expect(await screen.findByText("❌ d-1668x2388.png")).toBeInTheDocument();
    expect(
      screen.getByText(
        'Resolution: got 1668×2388 — expected one of: 2064×2752, 2752×2064, 2048×2732, 2732×2048 — this is an iPad 11" size, not iPad 13"',
      ),
    ).toBeInTheDocument();
  });

  it("the set is labelled from the spec table", async () => {
    await dropOnIpadSet("APP_IPAD_PRO_3GEN_11", "e-1668x2388.png");
    expect(screen.getAllByText('iPad 11"').length).toBeGreaterThan(0);
  });
});
