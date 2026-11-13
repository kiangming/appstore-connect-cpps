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
 * `Image`); only `fetch` is faked.
 *
 * G1 (Manager D1/D2/D5, Q-B) FLIPPED the cases tagged `[G1 FLIPPED]` on purpose
 * — each title says what it was. Cases tagged `[G1 NEW]` were added in G1 (the
 * upload half of the old editor-fallback case, now with a Dynamic Island
 * (large) image). Untagged cases (I1, I2, I8, the 6.5" set in the editor) are
 * G0's, unchanged.
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

describe.each([MANY, ONE])("iPhone routing (G0 pins; [G1 FLIPPED] marked) — $name", (d) => {
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

  it("[G1 FLIPPED] locale has a 6.7\" set ⇒ the 6.5\" images go to a NEW 6.5\" set (was: INTO the 6.7\" set)", async () => {
    expect(
      await runImport(d, {
        existing: [{ locale: "en-US", locId: "loc-en", sets: [{ id: "set-67", type: "APP_IPHONE_67" }] }],
        files: FACE_ID_LARGE,
      }),
    ).toEqual([
      ["POST set", "loc-en", "APP_IPHONE_65"],
      ["upload", "set-new-APP_IPHONE_65", "01-1284x2778.png"],
      ["upload", "set-new-APP_IPHONE_65", "02-1242x2688.png"],
    ]);
  });

  it("[G1 FLIPPED] locale has a 6.5\" AND a 6.7\" set ⇒ 6.5\" images reuse the 6.5\" set (was: the LAST iPhone set, 6.7\", won)", async () => {
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
      ["upload", "set-65", "01-1284x2778.png"],
      ["upload", "set-65", "02-1242x2688.png"],
    ]);
  });

  it("[G1 FLIPPED] neither ja's own 6.7\" set nor the ready locale's 6.5\" set decides: ja's 6.5\" image ⇒ new 6.5\" set on ja (was: ja's 6.7\" set)", async () => {
    expect(
      await runImport(d, {
        existing: [
          { locale: "en-US", locId: "loc-en", sets: [{ id: "set-65-en", type: "APP_IPHONE_65" }] },
          { locale: "ja", locId: "loc-ja", sets: [{ id: "set-67-ja", type: "APP_IPHONE_67" }] },
        ],
        files: ["en-US/promo.txt", "ja/screenshots/iphone/01-1284x2778.png"],
      }),
    ).toEqual([
      ["POST set", "loc-ja", "APP_IPHONE_65"],
      ["upload", "set-new-APP_IPHONE_65", "01-1284x2778.png"],
    ]);
  });

  it("[G1 FLIPPED] new locale does NOT inherit the ready locale's 6.7\" type ⇒ POST APP_IPHONE_65 for a 6.5\" image (was: POST APP_IPHONE_67)", async () => {
    expect(
      await runImport(d, {
        existing: [{ locale: "en-US", locId: "loc-en", sets: [{ id: "set-67", type: "APP_IPHONE_67" }] }],
        files: ["en-US/promo.txt", "ja/screenshots/iphone/01-1284x2778.png"],
      }),
    ).toEqual([
      ["POST set", "loc-new-ja", "APP_IPHONE_65"],
      ["upload", "set-new-APP_IPHONE_65", "01-1284x2778.png"],
    ]);
  });

  it("[G1 FLIPPED] a Dynamic Island (large) image (1290×2796) is accepted ⇒ POST APP_IPHONE_67, no warning (was: blocked, nothing sent)", async () => {
    const s = { existing: [], files: ["en-US/screenshots/iphone/01-1290x2796.png"] };
    const { container } = await previewOnly(d, s);
    expect(screen.getByRole("button", { name: /Import All/ })).not.toBeDisabled();
    expect(container.textContent).not.toMatch(/required iPhone screenshots/);
    document.body.innerHTML = "";
    expect(await runImport(d, s)).toEqual([
      ["POST set", "loc-new-en-US", "APP_IPHONE_67"],
      ["upload", "set-new-APP_IPHONE_67", "01-1290x2796.png"],
    ]);
  });
});

describe("iPhone routing — CppBulkImportDialog, brand-new CPP (G0, unchanged)", () => {
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

describe("iPhone in the editor", () => {
  it("[G1 FLIPPED] no iPhone set ⇒ fallback APP_IPHONE_67 (from the table, D5) REFUSES a 6.5\" image, Q-B (was: took it and POSTed APP_IPHONE_67)", async () => {
    await editorDrop([], "a-1284x2778.png");
    expect(await screen.findByText("❌ a-1284x2778.png")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Resolution: got 1284×2778 — expected one of: 1260×2736, 2736×1260, 1290×2796, 2796×1290, 1320×2868, 2868×1320 — this is an iPhone Face ID (large) size, not iPhone Dynamic Island (large)",
      ),
    ).toBeInTheDocument();
  });

  it("[G1 NEW] no iPhone set ⇒ a Dynamic Island (large) image is staged on the fallback and uploading POSTs APP_IPHONE_67", async () => {
    const requests = await editorDrop([], "a-1290x2796.png");
    expect(await screen.findByText("a-1290x2796.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Upload 1 screenshot/ }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests).toEqual([
      ["POST set", "loc-en-0000", "APP_IPHONE_67"],
      ["upload", "set-new-APP_IPHONE_67", "a-1290x2796.png"],
    ]);
  });

  it("[G1 FLIPPED] existing 6.7\" set TAKES a 6.7\" image (1290×2796) (was: refused)", async () => {
    await editorDrop([{ id: "set-67", type: "APP_IPHONE_67" }], "b-1290x2796.png");
    expect(await screen.findByText("b-1290x2796.png")).toBeInTheDocument();
    expect(screen.queryByText(/❌/)).toBeNull();
  });

  it("existing 6.5\" set takes a 6.5\" image (stays)", async () => {
    await editorDrop([{ id: "set-65", type: "APP_IPHONE_65" }], "c-1284x2778.png");
    expect(await screen.findByText("c-1284x2778.png")).toBeInTheDocument();
    expect(screen.queryByText(/❌/)).toBeNull();
  });
});

describe("[G1 FLIPPED] [CPP-iphone-default-mismatch] closed — was: the same 6.5\" image, a locale with no iPhone set ⇒ bulk APP_IPHONE_65 vs editor APP_IPHONE_67", () => {
  it("the same Dynamic Island (large) image ⇒ bulk and editor both POST APP_IPHONE_67", async () => {
    const bulk = await runImport(ONE, { existing: [{ locale: "en-US", locId: "loc-en", sets: [] }], files: ["en-US/screenshots/iphone/01-1290x2796.png"] });
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    installFakeImage();
    const editor = await editorDrop([], "01-1290x2796.png");
    await screen.findByText("01-1290x2796.png");
    fireEvent.click(screen.getByRole("button", { name: /Upload 1 screenshot/ }));
    await waitFor(() => expect(editor).toHaveLength(2));
    expect([bulk[0][2], editor[0][2]]).toEqual(["APP_IPHONE_67", "APP_IPHONE_67"]);
  });

  it("the same 6.5\" image ⇒ bulk POSTs APP_IPHONE_65 (its own type), the editor's fallback refuses it (Q-B: use bulk)", async () => {
    const bulk = await runImport(ONE, { existing: [{ locale: "en-US", locId: "loc-en", sets: [] }], files: ["en-US/screenshots/iphone/01-1284x2778.png"] });
    expect(bulk[0]).toEqual(["POST set", "loc-en", "APP_IPHONE_65"]);
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    installFakeImage();
    const editor = await editorDrop([], "01-1284x2778.png");
    expect(await screen.findByText("❌ 01-1284x2778.png")).toBeInTheDocument();
    expect(editor).toEqual([]);
  });
});
