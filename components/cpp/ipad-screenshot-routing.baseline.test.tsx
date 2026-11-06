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
 * ⚠ Cases tagged `[G1 FLIPS]` pin behaviour that Manager decided to change
 * (Q5 = classify by size): G1 replaces them on purpose, with the new
 * expectation, and says so in the commit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import type { AppCustomProductPage, AppCustomProductPageLocalization } from "@/types/asc";
import { CppBulkImportDialog } from "./CppBulkImportDialog";
import { BulkImportDialog } from "./BulkImportDialog";
import { fileAt, installFakeImage } from "./__fixtures__/screenshot-files";

type SetType = string;
interface ExistingLocale {
  locale: string;
  locId: string;
  sets: Array<{ id: string; type: SetType }>;
}
interface Scenario {
  existing: ExistingLocale[];
  /** Paths below `<locale>/`, e.g. `en-US/screenshots/ipad/01-2064x2752.png`. */
  files: string[];
}
type Req = ["POST set", string, SetType] | ["upload", string, string];

function installFetch(scenario: Scenario) {
  const requests: Req[] = [];
  const setsByLoc = new Map<string, Array<{ id: string; type: SetType }>>(
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
        data: sets.map((s) => ({ type: "appScreenshotSets", id: s.id, attributes: { screenshotDisplayType: s.type } })),
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

describe.each([MANY, ONE])("G0 iPad routing today — $name", (d) => {
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

  it("[G1 FLIPS] locale already has an 11\" set ⇒ the 13\" images go INTO the 11\" set", async () => {
    const reqs = await runImport(d, {
      existing: [{ locale: "en-US", locId: "loc-en", sets: [{ id: "set-11", type: "APP_IPAD_PRO_3GEN_11" }] }],
      files: IPAD_13,
    });
    expect(reqs).toEqual([
      ["upload", "set-11", "01-13in-2064x2752.png"],
      ["upload", "set-11", "02-13in-2048x2732.png"],
    ]);
  });

  it("[G1 FLIPS] locale has a 13\" AND an 11\" set ⇒ the LAST iPad set in Apple's list wins", async () => {
    const reqs = await runImport(d, {
      existing: [{
        locale: "en-US",
        locId: "loc-en",
        sets: [{ id: "set-13", type: "APP_IPAD_PRO_3GEN_129" }, { id: "set-11", type: "APP_IPAD_PRO_3GEN_11" }],
      }],
      files: IPAD_13,
    });
    expect(reqs).toEqual([
      ["upload", "set-11", "01-13in-2064x2752.png"],
      ["upload", "set-11", "02-13in-2048x2732.png"],
    ]);
  });

  it("[G1 FLIPS] the locale's OWN iPad set (11\") beats the first ready locale's (13\")", async () => {
    const reqs = await runImport(d, {
      existing: [
        { locale: "en-US", locId: "loc-en", sets: [{ id: "set-13-en", type: "APP_IPAD_PRO_3GEN_129" }] },
        { locale: "ja", locId: "loc-ja", sets: [{ id: "set-11-ja", type: "APP_IPAD_PRO_3GEN_11" }] },
      ],
      files: ["en-US/promo.txt", "ja/screenshots/ipad/01-13in-2064x2752.png"],
    });
    expect(reqs).toEqual([["upload", "set-11-ja", "01-13in-2064x2752.png"]]);
  });

  it("[G1 FLIPS] new locale inherits the first ready locale's iPad type (11\") ⇒ POST APP_IPAD_PRO_3GEN_11 for 13\" images", async () => {
    const reqs = await runImport(d, {
      existing: [{ locale: "en-US", locId: "loc-en", sets: [{ id: "set-11", type: "APP_IPAD_PRO_3GEN_11" }] }],
      files: ["en-US/promo.txt", "ja/screenshots/ipad/01-13in-2064x2752.png"],
    });
    expect(reqs).toEqual([
      ["POST set", "loc-new-ja", "APP_IPAD_PRO_3GEN_11"],
      ["upload", "set-new-APP_IPAD_PRO_3GEN_11", "01-13in-2064x2752.png"],
    ]);
  });

  it("[G1 FLIPS] an 11\" image (1668×2388) blocks the import: Import All disabled, nothing sent", async () => {
    installFetch({ existing: [], files: [] });
    const { container } = render(d.render({ existing: [], files: [] }));
    drop(container, d, { existing: [], files: ["en-US/screenshots/ipad/01-11in-1668x2388.png"] });
    await screen.findByText(/blocked \(invalid assets\)/);
    expect(screen.getByRole("button", { name: /Import All/ })).toBeDisabled();
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
