// @vitest-environment jsdom
/**
 * G0 — pins TODAY's iPad screenshot routing (which screenshot set each iPad
 * image is uploaded into) in BOTH bulk-import dialogs, before arc
 * `[CPP-bulkimport-ipad-screenshot-sizes]` changes it (design
 * docs/cpp-management/design-cpp-bulkimport-ipad-screenshot-sizes.md §1.3,
 * §P5.1).
 *
 * Real folder parser + real `validateScreenshot` (sizes come from the file
 * name via the fake `Image`); only `fetch` is faked. Every expected request
 * is written by hand.
 *
 * Today's rule (design §1.3): ONE iPad set per locale, picked as
 *   1. the locale's own last `APP_IPAD*` set, else
 *   2. the last `APP_IPAD*` set of the first "ready" locale, else
 *   3. `APP_IPAD_PRO_3GEN_129`.
 * The image size plays no part.
 *
 * G1 (Manager Q5 = classify by size) FLIPPED the five cases tagged
 * `[G1 FLIPPED]` on purpose — each title says what it was. The cases without
 * the tag are G0's, unchanged (bodies untouched). The "G1 —" suites below are
 * new: each iPad image goes to the set of the display type its size maps to
 * (lib/cpp/screenshot-specs.ts), one set per type, existing set of the same
 * type reused; iPhone unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { ReactElement } from "react";
import type { AppCustomProductPage, AppCustomProductPageLocalization } from "@/types/asc";
import { CppBulkImportDialog } from "./CppBulkImportDialog";
import { BulkImportDialog } from "./BulkImportDialog";
import { fileAt, installFakeImage } from "./__fixtures__/screenshot-files";

type SetType = string;
interface ExistingLocale {
  locale: string;
  locId: string;
  /** `count` = screenshots already in the set on Apple (default 0). */
  sets: Array<{ id: string; type: SetType; count?: number }>;
}
interface Scenario {
  existing: ExistingLocale[];
  /** Paths below `<locale>/`, e.g. `en-US/screenshots/ipad/01-2064x2752.png`. */
  files: string[];
}
type Req = ["POST set", string, SetType] | ["upload", string, string];

function installFetch(scenario: Scenario) {
  const requests: Req[] = [];
  const setsByLoc = new Map<string, Array<{ id: string; type: SetType; count?: number }>>(
    scenario.existing.map((l) => [l.locId, l.sets]),
  );
  const localizations = scenario.existing.map((l) => ({
    localization: { id: l.locId, attributes: { locale: l.locale } },
  }));

  const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.includes("/api/asc/hub-tracking/")) return ok({ run_id: null });
    if (url.endsWith("/app-info-localizations") && method === "GET") return ok({ locales: ["en-US", "ja"] });
    if (url === "/api/asc/cpps" && method === "POST") return ok({ data: { id: "cpp-new" } });
    if (/^\/api\/asc\/cpps\/cpp-[^/]+$/.test(url) && method === "GET") {
      // A brand-new CPP comes back with its primary-locale localization, no sets.
      const locs = url.endsWith("cpp-new")
        ? [{ localization: { id: "loc-primary", attributes: { locale: "en-US" } } }]
        : localizations;
      return ok({ versions: [{ version: { id: "v1" }, localizations: locs }] });
    }
    if (/\/api\/asc\/cpps\/[^/]+\/localizations$/.test(url) && method === "POST") {
      const { locale } = JSON.parse(String(init?.body)) as { locale: string };
      setsByLoc.set(`loc-new-${locale}`, []);
      return ok({ data: { id: `loc-new-${locale}` } });
    }
    if (url.startsWith("/api/asc/localizations/") && method === "PATCH") return ok({});
    if (url.startsWith("/api/asc/screenshot-sets?") && method === "GET") {
      const locId = new URL(url, "http://x").searchParams.get("localizationId") ?? "";
      const sets = setsByLoc.get(locId) ?? [];
      return ok({
        data: sets.map((s) => ({
          type: "appScreenshotSets",
          id: s.id,
          attributes: { screenshotDisplayType: s.type },
          relationships: {
            appScreenshots: { data: Array.from({ length: s.count ?? 0 }, (_, i) => ({ type: "appScreenshots", id: `${s.id}-ss${i}` })) },
          },
        })),
      });
    }
    if (url === "/api/asc/screenshot-sets" && method === "POST") {
      const b = JSON.parse(String(init?.body)) as { localizationId: string; screenshotDisplayType: SetType };
      requests.push(["POST set", b.localizationId, b.screenshotDisplayType]);
      const id = `set-new-${b.screenshotDisplayType}`;
      return ok({ data: { type: "appScreenshotSets", id, attributes: { screenshotDisplayType: b.screenshotDisplayType } } });
    }
    if (url.startsWith("/api/asc/preview-sets?") && method === "GET") return ok({ data: [] });
    if (url === "/api/asc/upload" && method === "POST") {
      const fd = init?.body as FormData;
      requests.push(["upload", String(fd.get("screenshotSetId")), (fd.get("file") as File).name]);
      return ok({});
    }
    return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return requests;
}

// ── The twin dialogs, behind one adapter ─────────────────────────────────────
interface DialogUnderTest {
  name: string;
  /** Render with the CPP "Summer" already existing (cppId `cpp-summer`). */
  render: (s: Scenario) => ReactElement;
  pathPrefix: string;
}

const MANY: DialogUnderTest = {
  name: "CppBulkImportDialog (many CPPs)",
  pathPrefix: "root/Summer/",
  render: () => (
    <CppBulkImportDialog
      appId="app-1"
      existingCpps={[{ type: "appCustomProductPages", id: "cpp-summer", attributes: { name: "Summer" } } as unknown as AppCustomProductPage]}
      onClose={() => {}}
      onComplete={() => {}}
    />
  ),
};

const ONE: DialogUnderTest = {
  name: "BulkImportDialog (one CPP)",
  pathPrefix: "root/",
  render: (s) => (
    <BulkImportDialog
      appId="app-1"
      cppId="cpp-summer"
      versionId="v1"
      existingLocalizations={s.existing.map(
        (l) => ({ type: "appCustomProductPageLocalizations", id: l.locId, attributes: { locale: l.locale } }) as unknown as AppCustomProductPageLocalization,
      )}
      onClose={() => {}}
      onComplete={() => {}}
    />
  ),
};

function drop(container: HTMLElement, d: DialogUnderTest, s: Scenario) {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error("file input not found");
  fireEvent.change(input, { target: { files: s.files.map((p) => fileAt(d.pathPrefix + p)) } });
}

async function runImport(d: DialogUnderTest, s: Scenario): Promise<Req[]> {
  const requests = installFetch(s);
  const { container } = render(d.render(s));
  drop(container, d, s);
  const btn = await screen.findByRole("button", { name: /Import All/ });
  await waitFor(() => expect(btn).not.toBeDisabled());
  fireEvent.click(btn);
  await screen.findByText(/Done —/, undefined, { timeout: 4000 });
  return requests;
}

beforeEach(() => installFakeImage());
afterEach(() => vi.unstubAllGlobals());

const IPAD_13 = ["en-US/screenshots/ipad/01-13in-2064x2752.png", "en-US/screenshots/ipad/02-13in-2048x2732.png"];

describe.each([MANY, ONE])("iPad routing (G0 pins; [G1 FLIPPED] marked) — $name", (d) => {
  it("no iPad set yet ⇒ one POST APP_IPAD_PRO_3GEN_129, both 13\" sizes into it, file-name order", async () => {
    const reqs = await runImport(d, { existing: [], files: IPAD_13 });
    expect(reqs).toEqual([
      ["POST set", "loc-new-en-US", "APP_IPAD_PRO_3GEN_129"],
      ["upload", "set-new-APP_IPAD_PRO_3GEN_129", "01-13in-2064x2752.png"],
      ["upload", "set-new-APP_IPAD_PRO_3GEN_129", "02-13in-2048x2732.png"],
    ]);
  });

  it("locale already has a 13\" set ⇒ reused, no POST", async () => {
    const reqs = await runImport(d, {
      existing: [{ locale: "en-US", locId: "loc-en", sets: [{ id: "set-13", type: "APP_IPAD_PRO_3GEN_129" }] }],
      files: IPAD_13,
    });
    expect(reqs).toEqual([
      ["upload", "set-13", "01-13in-2064x2752.png"],
      ["upload", "set-13", "02-13in-2048x2732.png"],
    ]);
  });

  it("[G1 FLIPPED] locale already has an 11\" set ⇒ 13\" images go to a NEW 13\" set (were: INTO the 11\" set)", async () => {
    const reqs = await runImport(d, {
      existing: [{ locale: "en-US", locId: "loc-en", sets: [{ id: "set-11", type: "APP_IPAD_PRO_3GEN_11" }] }],
      files: IPAD_13,
    });
    expect(reqs).toEqual([
      ["POST set", "loc-en", "APP_IPAD_PRO_3GEN_129"],
      ["upload", "set-new-APP_IPAD_PRO_3GEN_129", "01-13in-2064x2752.png"],
      ["upload", "set-new-APP_IPAD_PRO_3GEN_129", "02-13in-2048x2732.png"],
    ]);
  });

  it("[G1 FLIPPED] locale has a 13\" AND an 11\" set ⇒ 13\" images reuse the 13\" set (was: the LAST iPad set, 11\", won)", async () => {
    const reqs = await runImport(d, {
      existing: [{
        locale: "en-US",
        locId: "loc-en",
        sets: [{ id: "set-13", type: "APP_IPAD_PRO_3GEN_129" }, { id: "set-11", type: "APP_IPAD_PRO_3GEN_11" }],
      }],
      files: IPAD_13,
    });
    expect(reqs).toEqual([
      ["upload", "set-13", "01-13in-2064x2752.png"],
      ["upload", "set-13", "02-13in-2048x2732.png"],
    ]);
  });

  it("[G1 FLIPPED] neither the locale's own 11\" set nor the ready locale's 13\" set decides: ja's 13\" image ⇒ new 13\" set on ja (was: ja's 11\" set)", async () => {
    const reqs = await runImport(d, {
      existing: [
        { locale: "en-US", locId: "loc-en", sets: [{ id: "set-13-en", type: "APP_IPAD_PRO_3GEN_129" }] },
        { locale: "ja", locId: "loc-ja", sets: [{ id: "set-11-ja", type: "APP_IPAD_PRO_3GEN_11" }] },
      ],
      files: ["en-US/promo.txt", "ja/screenshots/ipad/01-13in-2064x2752.png"],
    });
    expect(reqs).toEqual([
      ["POST set", "loc-ja", "APP_IPAD_PRO_3GEN_129"],
      ["upload", "set-new-APP_IPAD_PRO_3GEN_129", "01-13in-2064x2752.png"],
    ]);
  });

  it("[G1 FLIPPED] new locale does NOT inherit the ready locale's 11\" type ⇒ POST APP_IPAD_PRO_3GEN_129 for a 13\" image (was: POST APP_IPAD_PRO_3GEN_11)", async () => {
    const reqs = await runImport(d, {
      existing: [{ locale: "en-US", locId: "loc-en", sets: [{ id: "set-11", type: "APP_IPAD_PRO_3GEN_11" }] }],
      files: ["en-US/promo.txt", "ja/screenshots/ipad/01-13in-2064x2752.png"],
    });
    expect(reqs).toEqual([
      ["POST set", "loc-new-ja", "APP_IPAD_PRO_3GEN_129"],
      ["upload", "set-new-APP_IPAD_PRO_3GEN_129", "01-13in-2064x2752.png"],
    ]);
  });

  it("[G1 FLIPPED] an 11\" image (1668×2388) is accepted ⇒ POST APP_IPAD_PRO_3GEN_11, with the no-13\" warning, Import not blocked (was: blocked)", async () => {
    const s: Scenario = { existing: [], files: ["en-US/screenshots/ipad/01-11in-1668x2388.png"] };
    const requests = installFetch(s);
    const { container } = render(d.render(s));
    drop(container, d, s);
    await screen.findByText(/without iPad 13" screenshots/);
    const btn = screen.getByRole("button", { name: /Import All/ });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    await screen.findByText(/Done —/, undefined, { timeout: 4000 });
    expect(requests).toEqual([
      ["POST set", "loc-new-en-US", "APP_IPAD_PRO_3GEN_11"],
      ["upload", "set-new-APP_IPAD_PRO_3GEN_11", "01-11in-1668x2388.png"],
    ]);
  });
});

describe("G0 iPad routing today — CppBulkImportDialog, brand-new CPP", () => {
  it("new CPP (primary locale created with the CPP) ⇒ POST APP_IPAD_PRO_3GEN_129 on that localization", async () => {
    const requests = installFetch({ existing: [], files: [] });
    const { container } = render(
      <CppBulkImportDialog appId="app-1" existingCpps={[]} onClose={() => {}} onComplete={() => {}} />,
    );
    const input = container.querySelector('input[type="file"]');
    if (!input) throw new Error("file input not found");
    fireEvent.change(input, {
      target: { files: [fileAt("root/Winter/en-US/screenshots/ipad/01-13in-2064x2752.png")] },
    });
    const btn = await screen.findByRole("button", { name: /Import All/ });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    await screen.findByText(/Done —/, undefined, { timeout: 4000 });
    expect(requests).toEqual([
      ["POST set", "loc-primary", "APP_IPAD_PRO_3GEN_129"],
      ["upload", "set-new-APP_IPAD_PRO_3GEN_129", "01-13in-2064x2752.png"],
    ]);
  });
});

// ── G1 ──────────────────────────────────────────────────────────────────────

/** Open every collapsed row (CPP + locale chevrons) so Preview details render. */
async function expandAll(container: HTMLElement) {
  for (let round = 0; round < 4; round++) {
    const closed = Array.from(container.querySelectorAll("svg.lucide-chevron-right"))
      .filter((svg) => !svg.getAttribute("class")?.includes("rotate-90"))
      .map((svg) => svg.closest("button"))
      .filter((b): b is HTMLButtonElement => b !== null);
    if (closed.length === 0) return;
    await act(async () => closed.forEach((b) => fireEvent.click(b)));
  }
}

async function previewOnly(d: DialogUnderTest, s: Scenario) {
  const requests = installFetch(s);
  const { container } = render(d.render(s));
  drop(container, d, s);
  await screen.findByRole("button", { name: /Import All/ });
  await waitFor(() => expect(container.textContent).toMatch(/to import/));
  await expandAll(container);
  return { requests, container };
}

const MIXED = [
  "en-US/screenshots/ipad/01-11in-1668x2388.png",
  "en-US/screenshots/ipad/02-13in-2064x2752.png",
  "en-US/screenshots/ipad/03-11in-1640x2360.png",
  "en-US/screenshots/ipad/04-13in-2732x2048.png",
];
const MIXED_EXPECTED: Req[] = [
  ["POST set", "loc-new-en-US", "APP_IPAD_PRO_3GEN_129"],
  ["upload", "set-new-APP_IPAD_PRO_3GEN_129", "02-13in-2064x2752.png"],
  ["upload", "set-new-APP_IPAD_PRO_3GEN_129", "04-13in-2732x2048.png"],
  ["POST set", "loc-new-en-US", "APP_IPAD_PRO_3GEN_11"],
  ["upload", "set-new-APP_IPAD_PRO_3GEN_11", "01-11in-1668x2388.png"],
  ["upload", "set-new-APP_IPAD_PRO_3GEN_11", "03-11in-1640x2360.png"],
];

describe.each([MANY, ONE])("G1 — iPad images routed by size — $name", (d) => {
  it("mixed 13\" + 11\" folder ⇒ two sets, 13\" first, file-name order inside each", async () => {
    expect(await runImport(d, { existing: [], files: MIXED })).toEqual(MIXED_EXPECTED);
  });

  it("one image per group (2048×2732 included) ⇒ 13\", 11\", 10.5\", 9.7\" sets; never 12.9\" (Q1)", async () => {
    const reqs = await runImport(d, {
      existing: [],
      files: [
        "en-US/screenshots/ipad/01-13in-2064x2752.png",
        "en-US/screenshots/ipad/02-12.9in-2048x2732.png",
        "en-US/screenshots/ipad/03-11in-1512x2316.png",
        "en-US/screenshots/ipad/04-10.5in-1668x2224.png",
        "en-US/screenshots/ipad/05-9.7in-768x1024.png",
      ],
    });
    expect(reqs).toEqual([
      ["POST set", "loc-new-en-US", "APP_IPAD_PRO_3GEN_129"],
      ["upload", "set-new-APP_IPAD_PRO_3GEN_129", "01-13in-2064x2752.png"],
      ["upload", "set-new-APP_IPAD_PRO_3GEN_129", "02-12.9in-2048x2732.png"],
      ["POST set", "loc-new-en-US", "APP_IPAD_PRO_3GEN_11"],
      ["upload", "set-new-APP_IPAD_PRO_3GEN_11", "03-11in-1512x2316.png"],
      ["POST set", "loc-new-en-US", "APP_IPAD_105"],
      ["upload", "set-new-APP_IPAD_105", "04-10.5in-1668x2224.png"],
      ["POST set", "loc-new-en-US", "APP_IPAD_97"],
      ["upload", "set-new-APP_IPAD_97", "05-9.7in-768x1024.png"],
    ]);
  });

  it("existing 11\" set is reused for 11\" images; 13\" images get a new 13\" set", async () => {
    const reqs = await runImport(d, {
      existing: [{ locale: "en-US", locId: "loc-en", sets: [{ id: "set-11", type: "APP_IPAD_PRO_3GEN_11" }] }],
      files: ["en-US/screenshots/ipad/01-11in-1668x2388.png", "en-US/screenshots/ipad/02-13in-2064x2752.png"],
    });
    expect(reqs).toEqual([
      ["POST set", "loc-en", "APP_IPAD_PRO_3GEN_129"],
      ["upload", "set-new-APP_IPAD_PRO_3GEN_129", "02-13in-2064x2752.png"],
      ["upload", "set-11", "01-11in-1668x2388.png"],
    ]);
  });

  it("iPhone unchanged: no set ⇒ POST APP_IPHONE_65; iPhone group goes before the iPad groups", async () => {
    const reqs = await runImport(d, {
      existing: [],
      files: ["en-US/screenshots/ipad/01-13in-2064x2752.png", "en-US/screenshots/iphone/01-1284x2778.png"],
    });
    expect(reqs).toEqual([
      ["POST set", "loc-new-en-US", "APP_IPHONE_65"],
      ["upload", "set-new-APP_IPHONE_65", "01-1284x2778.png"],
      ["POST set", "loc-new-en-US", "APP_IPAD_PRO_3GEN_129"],
      ["upload", "set-new-APP_IPAD_PRO_3GEN_129", "01-13in-2064x2752.png"],
    ]);
  });

  it("iPhone unchanged: existing APP_IPHONE_67 set is reused", async () => {
    const reqs = await runImport(d, {
      existing: [{ locale: "en-US", locId: "loc-en", sets: [{ id: "set-67", type: "APP_IPHONE_67" }] }],
      files: ["en-US/screenshots/iphone/01-1284x2778.png"],
    });
    expect(reqs).toEqual([["upload", "set-67", "01-1284x2778.png"]]);
  });

  it("Preview lists which images go to which screen type", async () => {
    const { container } = await previewOnly(d, { existing: [], files: MIXED });
    expect(container.textContent).toContain('iPad 13": 02-13in-2064x2752.png, 04-13in-2732x2048.png');
    expect(container.textContent).toContain('iPad 11": 01-11in-1668x2388.png, 03-11in-1640x2360.png');
  });

  it("wrong size (1600×2400) ⇒ blocked, §4.3 sentence shown, nothing sent", async () => {
    const { requests, container } = await previewOnly(d, {
      existing: [],
      files: ["en-US/screenshots/ipad/01-13in-2064x2752.png", "en-US/screenshots/ipad/02-wrong-1600x2400.png"],
    });
    expect(screen.getByRole("button", { name: /Import All/ })).toBeDisabled();
    expect(container.textContent).toContain("02-wrong-1600x2400.png: 1600×2400 is not a valid iPad screenshot size. Valid iPad sizes — 13\": 2064×2752");
    expect(requests).toEqual([]);
  });

  it("an iPhone image in ipad/ ⇒ blocked, with the move-it hint", async () => {
    const { container } = await previewOnly(d, {
      existing: [],
      files: ["en-US/screenshots/ipad/01-1284x2778.png"],
    });
    expect(screen.getByRole("button", { name: /Import All/ })).toBeDisabled();
    expect(container.textContent).toContain(
      "01-1284x2778.png: 1284×2778 is not a valid iPad screenshot size — this looks like an iPhone screenshot; move it to screenshots/iphone/.",
    );
  });

  it("11 images of one display type ⇒ blocked (max 10)", async () => {
    const files = Array.from({ length: 11 }, (_, i) => `en-US/screenshots/ipad/${String(i).padStart(2, "0")}-1668x2388.png`);
    const { container } = await previewOnly(d, { existing: [], files });
    expect(screen.getByRole("button", { name: /Import All/ })).toBeDisabled();
    expect(container.textContent).toContain('Too many screenshots for iPad 11": 11 — max 10');
  });

  it("screenshots already on Apple count: 8 in the 11\" set + 3 new ⇒ blocked", async () => {
    const { container } = await previewOnly(d, {
      existing: [{ locale: "en-US", locId: "loc-en", sets: [{ id: "set-11", type: "APP_IPAD_PRO_3GEN_11", count: 8 }] }],
      files: ["a-1668x2388.png", "b-1668x2388.png", "c-1668x2388.png"].map((n) => `en-US/screenshots/ipad/${n}`),
    });
    expect(screen.getByRole("button", { name: /Import All/ })).toBeDisabled();
    expect(container.textContent).toContain('Too many screenshots for iPad 11": 11 (8 already on Apple + 3 new) — max 10');
  });

  it("only 11\" images but the locale already has a 13\" set ⇒ no warning", async () => {
    const { container } = await previewOnly(d, {
      existing: [{ locale: "en-US", locId: "loc-en", sets: [{ id: "set-13", type: "APP_IPAD_PRO_3GEN_129", count: 3 }] }],
      files: ["en-US/screenshots/ipad/01-11in-1668x2388.png"],
    });
    expect(container.textContent).not.toMatch(/No iPad 13"|without iPad 13"/);
    expect(screen.getByRole("button", { name: /Import All/ })).not.toBeDisabled();
  });

  it("only 11\" images, no 13\" set ⇒ the warning sentence is shown in the locale", async () => {
    const { container } = await previewOnly(d, { existing: [], files: ["en-US/screenshots/ipad/01-11in-1668x2388.png"] });
    expect(container.textContent).toContain(
      'No iPad 13" screenshots — Apple requires iPad 13" screenshots for apps that run on iPad. Import is not blocked.',
    );
  });
});

describe("G1 — twin: the same images through both dialogs ⇒ the same request sequence", () => {
  it("mixed 13\" + 11\" + iPhone, existing 11\" set", async () => {
    const s: Scenario = {
      existing: [{ locale: "en-US", locId: "loc-en", sets: [{ id: "set-11", type: "APP_IPAD_PRO_3GEN_11" }] }],
      files: [...MIXED, "en-US/screenshots/iphone/01-1242x2688.png"],
    };
    const many = await runImport(MANY, s);
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    installFakeImage();
    const one = await runImport(ONE, s);
    expect(many.length).toBeGreaterThan(0);
    expect(one).toEqual(many);
  });
});
