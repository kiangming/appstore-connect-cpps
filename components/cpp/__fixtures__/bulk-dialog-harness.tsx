/**
 * Test-only harness for the two bulk-import dialogs (CppBulkImportDialog —
 * many CPPs, BulkImportDialog — one CPP): a faked `fetch` that records every
 * `POST /api/asc/screenshot-sets` and `POST /api/asc/upload`, and one adapter
 * per dialog so the same scenario runs through both (twin, KB P1).
 *
 * Copied from components/cpp/ipad-screenshot-routing.baseline.test.tsx (arc
 * `[CPP-bulkimport-ipad-screenshot-sizes]`) for arc
 * `[CPP-bulkimport-iphone-screenshot-sizes]`; the iPad test keeps its own copy
 * untouched (Manager: iPad tests stay green without edits).
 */
import { expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { ReactElement } from "react";
import type { AppCustomProductPage, AppCustomProductPageLocalization } from "@/types/asc";
import { CppBulkImportDialog } from "../CppBulkImportDialog";
import { BulkImportDialog } from "../BulkImportDialog";
import { fileAt } from "./screenshot-files";

export type SetType = string;
export interface ExistingLocale {
  locale: string;
  locId: string;
  /** `count` = screenshots already in the set on Apple; `listed` = how many the relationship list names. */
  sets: Array<{ id: string; type: SetType; count?: number; listed?: number }>;
}
export interface Scenario {
  existing: ExistingLocale[];
  /** Paths below `<locale>/`, e.g. `en-US/screenshots/iphone/01-1284x2778.png`. */
  files: string[];
}
export type Req = ["POST set", string, SetType] | ["upload", string, string];

export function installFetch(scenario: Scenario): Req[] {
  const requests: Req[] = [];
  const setsByLoc = new Map<string, Array<{ id: string; type: SetType; count?: number; listed?: number }>>(
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
      const shotsOf = (s: { id: string; count?: number }) =>
        Array.from({ length: s.count ?? 0 }, (_, i) => ({ type: "appScreenshots", id: `${s.id}-ss${i}` }));
      return ok({
        data: sets.map((s) => ({
          type: "appScreenshotSets",
          id: s.id,
          attributes: { screenshotDisplayType: s.type },
          relationships: { appScreenshots: { data: shotsOf(s).slice(0, s.listed ?? s.count ?? 0) } },
        })),
        included: sets.flatMap(shotsOf),
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

export interface DialogUnderTest {
  name: string;
  /** Render with the CPP "Summer" already existing (cppId `cpp-summer`). */
  render: (s: Scenario) => ReactElement;
  pathPrefix: string;
}

export const MANY: DialogUnderTest = {
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

export const ONE: DialogUnderTest = {
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

export function drop(container: HTMLElement, d: DialogUnderTest, s: Scenario): void {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error("file input not found");
  fireEvent.change(input, { target: { files: s.files.map((p) => fileAt(d.pathPrefix + p)) } });
}

export async function runImport(d: DialogUnderTest, s: Scenario): Promise<Req[]> {
  const requests = installFetch(s);
  const { container } = render(d.render(s));
  drop(container, d, s);
  const btn = await screen.findByRole("button", { name: /Import All/ });
  await waitFor(() => expect(btn).not.toBeDisabled());
  fireEvent.click(btn);
  await screen.findByText(/Done —/, undefined, { timeout: 4000 });
  return requests;
}

/** Open every collapsed row (CPP + locale chevrons) so Preview details render. */
export async function expandAll(container: HTMLElement): Promise<void> {
  for (let round = 0; round < 4; round++) {
    const closed = Array.from(container.querySelectorAll("svg.lucide-chevron-right"))
      .filter((svg) => !svg.getAttribute("class")?.includes("rotate-90"))
      .map((svg) => svg.closest("button"))
      .filter((b): b is HTMLButtonElement => b !== null);
    if (closed.length === 0) return;
    await act(async () => closed.forEach((b) => fireEvent.click(b)));
  }
}

/** Drop the folder, wait for Preview, expand everything; nothing is imported. */
export async function previewOnly(d: DialogUnderTest, s: Scenario): Promise<{ requests: Req[]; container: HTMLElement }> {
  const requests = installFetch(s);
  const { container } = render(d.render(s));
  drop(container, d, s);
  await screen.findByRole("button", { name: /Import All/ });
  await waitFor(() => expect(container.textContent).toMatch(/to import/));
  await expandAll(container);
  return { requests, container };
}
