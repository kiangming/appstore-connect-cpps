// @vitest-environment jsdom
/**
 * G0 — pins TODAY's iPhone screenshot routing in both bulk dialogs and the
 * editor, before arc `[CPP-bulkimport-iphone-screenshot-sizes]` changes it
 * (design docs/cpp-management/design-cpp-bulkimport-iphone-screenshot-sizes.md
 * §C1, §G0).
 *
 * Today's iPhone rule (left in place by the iPad arc): ONE iPhone set per
 * locale, picked as
 *   1. the locale's own last `APP_IPHONE*` set, else
 *   2. the last `APP_IPHONE*` set of the first "ready" locale, else
 *   3. `APP_IPHONE_65` (both dialogs).
 * The editor's fallback for a locale with no iPhone set is `APP_IPHONE_67`
 * (BACKLOG `[CPP-iphone-default-mismatch]`). Image size plays no part.
 *
 * Real folder parser + real validator (size from the file name via the fake
 * `Image`); only `fetch` is faked. Cases tagged `[G1 FLIPS]` are changed on
 * purpose by Manager's D1/D2/D5; untagged cases must stay green unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { AppCustomProductPageLocalization } from "@/types/asc";
import { CppBulkImportDialog } from "./CppBulkImportDialog";
import { LocalizationManager } from "./LocalizationManager";
import { fileAt, installFakeImage } from "./__fixtures__/screenshot-files";
import { MANY, ONE, installFetch, previewOnly, runImport, type Req } from "./__fixtures__/bulk-dialog-harness";

beforeEach(() => installFakeImage());
afterEach(() => vi.unstubAllGlobals());

const FACE_ID_LARGE = ["en-US/screenshots/iphone/01-1284x2778.png", "en-US/screenshots/iphone/02-1242x2688.png"];

describe.each([MANY, ONE])("iPhone routing today — $name", (d) => {
  it("no iPhone set ⇒ one POST APP_IPHONE_65, both 6.5\" images into it, file-name order", async () => {
    expect(await runImport(d, { existing: [], files: FACE_ID_LARGE })).toEqual([
      ["POST set", "loc-new-en-US", "APP_IPHONE_65"],
      ["upload", "set-new-APP_IPHONE_65", "01-1284x2778.png"],
      ["upload", "set-new-APP_IPHONE_65", "02-1242x2688.png"],
    ]);
  });

  it("locale already has a 6.5\" set ⇒ reused, no POST", async () => {
    expect(
      await runImport(d, {
        existing: [{ locale: "en-US", locId: "loc-en", sets: [{ id: "set-65", type: "APP_IPHONE_65" }] }],
        files: FACE_ID_LARGE,
      }),
    ).toEqual([
      ["upload", "set-65", "01-1284x2778.png"],
      ["upload", "set-65", "02-1242x2688.png"],
    ]);
  });

  it("[G1 FLIPS] locale has a 6.7\" set ⇒ the 6.5\" images go INTO the 6.7\" set", async () => {
    expect(
      await runImport(d, {
        existing: [{ locale: "en-US", locId: "loc-en", sets: [{ id: "set-67", type: "APP_IPHONE_67" }] }],
        files: FACE_ID_LARGE,
      }),
    ).toEqual([
      ["upload", "set-67", "01-1284x2778.png"],
      ["upload", "set-67", "02-1242x2688.png"],
    ]);
  });

  it("[G1 FLIPS] locale has a 6.5\" AND a 6.7\" set ⇒ the LAST iPhone set in Apple's list wins", async () => {
    expect(
      await runImport(d, {
        existing: [{
          locale: "en-US",
          locId: "loc-en",
          sets: [{ id: "set-65", type: "APP_IPHONE_65" }, { id: "set-67", type: "APP_IPHONE_67" }],
        }],
        files: FACE_ID_LARGE,
      }),
    ).toEqual([
      ["upload", "set-67", "01-1284x2778.png"],
      ["upload", "set-67", "02-1242x2688.png"],
    ]);
  });

  it("[G1 FLIPS] the locale's OWN iPhone set (6.7\") beats the first ready locale's (6.5\")", async () => {
    expect(
      await runImport(d, {
        existing: [
          { locale: "en-US", locId: "loc-en", sets: [{ id: "set-65-en", type: "APP_IPHONE_65" }] },
          { locale: "ja", locId: "loc-ja", sets: [{ id: "set-67-ja", type: "APP_IPHONE_67" }] },
        ],
        files: ["en-US/promo.txt", "ja/screenshots/iphone/01-1284x2778.png"],
      }),
    ).toEqual([["upload", "set-67-ja", "01-1284x2778.png"]]);
  });

  it("[G1 FLIPS] new locale inherits the first ready locale's iPhone type (6.7\") ⇒ POST APP_IPHONE_67 for a 6.5\" image", async () => {
    expect(
      await runImport(d, {
        existing: [{ locale: "en-US", locId: "loc-en", sets: [{ id: "set-67", type: "APP_IPHONE_67" }] }],
        files: ["en-US/promo.txt", "ja/screenshots/iphone/01-1284x2778.png"],
      }),
    ).toEqual([
      ["POST set", "loc-new-ja", "APP_IPHONE_67"],
      ["upload", "set-new-APP_IPHONE_67", "01-1284x2778.png"],
    ]);
  });

  it("[G1 FLIPS] a Dynamic Island (large) image (1290×2796) blocks the import: Import All disabled, nothing sent", async () => {
    const { requests } = await previewOnly(d, { existing: [], files: ["en-US/screenshots/iphone/01-1290x2796.png"] });
    expect(screen.getByRole("button", { name: /Import All/ })).toBeDisabled();
    expect(requests).toEqual([]);
  });
});

describe("iPhone routing today — CppBulkImportDialog, brand-new CPP", () => {
  it("new CPP (primary locale created with the CPP) ⇒ POST APP_IPHONE_65 on that localization", async () => {
    const requests = installFetch({ existing: [], files: [] });
    const { container } = render(
      <CppBulkImportDialog appId="app-1" existingCpps={[]} onClose={() => {}} onComplete={() => {}} />,
    );
    const input = container.querySelector('input[type="file"]');
    if (!input) throw new Error("file input not found");
    fireEvent.change(input, { target: { files: [fileAt("root/Winter/en-US/screenshots/iphone/01-1284x2778.png")] } });
    const btn = await screen.findByRole("button", { name: /Import All/ });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    await screen.findByText(/Done —/, undefined, { timeout: 4000 });
    expect(requests).toEqual([
      ["POST set", "loc-primary", "APP_IPHONE_65"],
      ["upload", "set-new-APP_IPHONE_65", "01-1284x2778.png"],
    ]);
  });
});

// ── Editor ───────────────────────────────────────────────────────────────────

function installEditorFetch(sets: Array<{ id: string; type: string }>): Req[] {
  const requests: Req[] = [];
  const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.startsWith("/api/asc/screenshot-sets?")) {
        return ok({
          data: sets.map((s) => ({ type: "appScreenshotSets", id: s.id, attributes: { screenshotDisplayType: s.type }, relationships: { appScreenshots: { data: [] } } })),
          included: [],
        });
      }
      if (url.startsWith("/api/asc/preview-sets?")) return ok({ data: [], included: [] });
      if (url === "/api/asc/screenshot-sets" && method === "POST") {
        const b = JSON.parse(String(init?.body)) as { localizationId: string; screenshotDisplayType: string };
        requests.push(["POST set", b.localizationId, b.screenshotDisplayType]);
        return ok({ data: { type: "appScreenshotSets", id: `set-new-${b.screenshotDisplayType}`, attributes: { screenshotDisplayType: b.screenshotDisplayType } } });
      }
      if (url === "/api/asc/upload" && method === "POST") {
        const fd = init?.body as FormData;
        requests.push(["upload", String(fd.get("screenshotSetId")), (fd.get("file") as File).name]);
        return ok({});
      }
      return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
    }),
  );
  return requests;
}

/** Open locale en-US in the editor (iPhone tab is the default) and drop one image. */
async function editorDrop(sets: Array<{ id: string; type: string }>, fileName: string): Promise<Req[]> {
  const requests = installEditorFetch(sets);
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
  return requests;
}

describe("iPhone in the editor today", () => {
  it("[G1 FLIPS] no iPhone set ⇒ fallback APP_IPHONE_67 takes a 6.5\" image, uploading POSTs APP_IPHONE_67", async () => {
    const requests = await editorDrop([], "a-1284x2778.png");
    expect(await screen.findByText("a-1284x2778.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Upload 1 screenshot/ }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests).toEqual([
      ["POST set", "loc-en-0000", "APP_IPHONE_67"],
      ["upload", "set-new-APP_IPHONE_67", "a-1284x2778.png"],
    ]);
  });

  it("[G1 FLIPS] existing 6.7\" set refuses a 6.7\" image (1290×2796)", async () => {
    await editorDrop([{ id: "set-67", type: "APP_IPHONE_67" }], "b-1290x2796.png");
    expect(await screen.findByText("❌ b-1290x2796.png")).toBeInTheDocument();
  });

  it("existing 6.5\" set takes a 6.5\" image (stays)", async () => {
    await editorDrop([{ id: "set-65", type: "APP_IPHONE_65" }], "c-1284x2778.png");
    expect(await screen.findByText("c-1284x2778.png")).toBeInTheDocument();
    expect(screen.queryByText(/❌/)).toBeNull();
  });
});

describe("[G1 FLIPS] [CPP-iphone-default-mismatch] — the same 6.5\" image, a locale with no iPhone set", () => {
  it("bulk POSTs APP_IPHONE_65, the editor POSTs APP_IPHONE_67", async () => {
    const bulk = await runImport(ONE, { existing: [{ locale: "en-US", locId: "loc-en", sets: [] }], files: ["en-US/screenshots/iphone/01-1284x2778.png"] });
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    installFakeImage();
    const editor = await editorDrop([], "01-1284x2778.png");
    await screen.findByText("01-1284x2778.png");
    fireEvent.click(screen.getByRole("button", { name: /Upload 1 screenshot/ }));
    await waitFor(() => expect(editor).toHaveLength(2));
    expect([bulk[0][2], editor[0][2]]).toEqual(["APP_IPHONE_65", "APP_IPHONE_67"]);
  });
});
