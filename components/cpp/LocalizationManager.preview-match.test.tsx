// @vitest-environment jsdom
/**
 * G1c — the CPP editor shows the device's existing preview (video) set even
 * when its type differs from the first screenshot set's type (arc
 * `[CPP-bulkimport-iphone-screenshot-sizes]`, adversarial review of G1).
 *
 * Why: screenshots are now routed by image SIZE (iPad arc, iPhone arc), while
 * bulk still puts videos in the device's preview default (IPHONE_65 /
 * IPAD_PRO_3GEN_129 — Preview video unchanged by Manager decision). A locale
 * imported with Dynamic Island (large) screenshots + a video ends with
 * screenshot set APP_IPHONE_67 and preview set IPHONE_65. Before G1c the editor
 * matched the preview set ONLY to the first screenshot set's type, so it said
 * "There's no preview of this device type." and a re-dropped video created a
 * second preview set. An exact type match is still preferred.
 *
 * Real component; only `fetch` is faked.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { AppCustomProductPageLocalization } from "@/types/asc";
import { LocalizationManager } from "./LocalizationManager";

function installFetch(
  screenshotSets: string[],
  previewSets: Array<{ type: string; videos: number }>,
) {
  const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/asc/screenshot-sets?")) {
        return ok({
          data: screenshotSets.map((t, i) => ({ type: "appScreenshotSets", id: `ss-${i}`, attributes: { screenshotDisplayType: t }, relationships: { appScreenshots: { data: [] } } })),
          included: [],
        });
      }
      if (url.startsWith("/api/asc/preview-sets?")) {
        return ok({
          data: previewSets.map((p, i) => ({
            type: "appPreviewSets",
            id: `pv-${i}`,
            attributes: { previewType: p.type },
            relationships: { appPreviews: { data: Array.from({ length: p.videos }, (_, k) => ({ type: "appPreviews", id: `pv-${i}-v${k}` })) } },
          })),
          included: previewSets.flatMap((p, i) =>
            Array.from({ length: p.videos }, (_, k) => ({ type: "appPreviews", id: `pv-${i}-v${k}`, attributes: { fileName: `v${i}-${k}.mp4` } })),
          ),
        });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
}

async function openLocale() {
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
  await screen.findAllByText("App Previews");
}

afterEach(() => vi.unstubAllGlobals());

describe("G1c — editor: a device's preview set is shown even when its type differs from the screenshot set's", () => {
  it("iPhone: screenshot set APP_IPHONE_67 + preview set IPHONE_65 with a video ⇒ the video is shown (was: 'There's no preview of this device type.')", async () => {
    installFetch(["APP_IPHONE_67"], [{ type: "IPHONE_65", videos: 1 }]);
    await openLocale();
    expect(await screen.findByText("Current (1)")).toBeInTheDocument();
    expect(screen.queryByText("There's no preview of this device type.")).toBeNull();
  });

  it("iPad: screenshot set APP_IPAD_PRO_3GEN_11 + preview set IPAD_PRO_3GEN_129 with 2 videos ⇒ shown on the iPad tab", async () => {
    installFetch(["APP_IPAD_PRO_3GEN_11"], [{ type: "IPAD_PRO_3GEN_129", videos: 2 }]);
    await openLocale();
    const ipadTabs = await screen.findAllByText("iPad");
    fireEvent.click(ipadTabs[ipadTabs.length - 1].closest("button") as HTMLElement); // the App Previews tabs come last
    expect(await screen.findByText("Current (2)")).toBeInTheDocument();
  });

  it("an EXACT type match still wins over the first preview set (unchanged behaviour)", async () => {
    installFetch(["APP_IPHONE_65"], [{ type: "IPHONE_67", videos: 1 }, { type: "IPHONE_65", videos: 2 }]);
    await openLocale();
    expect(await screen.findByText("Current (2)")).toBeInTheDocument();
    expect(screen.queryByText("Current (1)")).toBeNull();
  });

  it("a locale with a video but NO screenshot set yet ⇒ the video is shown (was: empty state — nothing to match against)", async () => {
    installFetch([], [{ type: "IPHONE_65", videos: 1 }]);
    await openLocale();
    expect(await screen.findByText("Current (1)")).toBeInTheDocument();
  });

  it("no preview set at all ⇒ still the empty state with the fallback dropzone (unchanged)", async () => {
    installFetch(["APP_IPHONE_67"], []);
    await openLocale();
    expect(await screen.findByText("There's no preview of this device type.")).toBeInTheDocument();
  });
});
