// @vitest-environment jsdom
/**
 * G1 — the CPP editor checks a dropped iPhone screenshot against the TARGET
 * set's sizes (arc `[CPP-bulkimport-iphone-screenshot-sizes]`, Manager D2) and
 * labels sets with Apple's group names (Q-C). Before G1 every iPhone set took
 * exactly the four 6.5" sizes. iPad editor test: LocalizationManager.screenshot-target.test.tsx.
 *
 * Real component, real `validateScreenshotForDisplayType`; size from the file
 * name via the fake `Image`; only `fetch` is faked.
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

/** Open locale en-US (the iPhone tab is the default) and drop one image on the set. */
async function dropOnIphoneSet(setType: string, fileName: string) {
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
  const zone = (await screen.findAllByText("Drop screenshots or click to browse"))[0].closest("div.border-dashed") as HTMLElement;
  fireEvent.drop(zone, { dataTransfer: { files: [new File(["x"], fileName, { type: "image/png" })] } });
}

beforeEach(() => installFakeImage());
afterEach(() => vi.unstubAllGlobals());

describe("editor — iPhone, check against the TARGET set (D2)", () => {
  it("Face ID (medium) image on the APP_IPHONE_58 set ⇒ staged", async () => {
    await dropOnIphoneSet("APP_IPHONE_58", "a-1170x2532.png");
    expect(await screen.findByText("a-1170x2532.png")).toBeInTheDocument();
    expect(screen.queryByText(/❌/)).toBeNull();
  });

  it("Face ID (medium) image on the Dynamic Island (medium) set ⇒ refused, names its real group", async () => {
    await dropOnIphoneSet("APP_IPHONE_61", "b-1170x2532.png");
    expect(await screen.findByText("❌ b-1170x2532.png")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Resolution: got 1170×2532 — expected one of: 1179×2556, 2556×1179, 1206×2622, 2622×1206 — this is an iPhone Face ID (medium) size, not iPhone Dynamic Island (medium)",
      ),
    ).toBeInTheDocument();
  });

  it("Home Button (3.5\") image on its set ⇒ staged", async () => {
    await dropOnIphoneSet("APP_IPHONE_35", "c-960x600.png");
    expect(await screen.findByText("c-960x600.png")).toBeInTheDocument();
  });

  it("Duo image ⇒ refused with the Duo sentence (D6, Q-D)", async () => {
    await dropOnIphoneSet("APP_IPHONE_67", "d-2007x2853.png");
    expect(await screen.findByText("❌ d-2007x2853.png")).toBeInTheDocument();
    expect(
      screen.getByText(
        "2007×2853 is an iPhone Duo screenshot size — iPhone Duo is not supported by the App Store Connect API yet; upload it manually on App Store Connect.",
      ),
    ).toBeInTheDocument();
  });

  it("the set is labelled with Apple's group name (Q-C)", async () => {
    await dropOnIphoneSet("APP_IPHONE_58", "e-1125x2436.png");
    expect(screen.getAllByText("iPhone Face ID (medium)").length).toBeGreaterThan(0);
  });
});
