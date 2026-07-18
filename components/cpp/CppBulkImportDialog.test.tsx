// @vitest-environment jsdom

/**
 * Hub-tracking wiring for CPP Bulk Import (docs/cpp-management/
 * design-cpp-hub-tracking.md). Covers the four load-bearing behaviors the
 * design calls out: the SUCCESS/PARTIAL/FAILED terminal status actually
 * reaching /finalize end-to-end, the race-drop hardening (a late /start
 * response after upload has begun is never adopted, never guessed into a
 * wrong status, and best-effort-closes the orphan), and the two-state
 * cancel-guard windows (no cancel before a run has started; cancel allowed
 * once started but before upload; suppressed once upload has begun).
 *
 * lib/parseCppFolderStructure is mocked — this suite is about the Hub
 * tracking wiring, not the folder-parsing logic, which has no test
 * coverage of its own to duplicate here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const parseCppFolderStructureMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/parseCppFolderStructure", () => ({
  parseCppFolderStructure: parseCppFolderStructureMock,
}));

import { CppBulkImportDialog } from "./CppBulkImportDialog";

const START_URL = "/api/asc/hub-tracking/start";
const CANCEL_URL = "/api/asc/hub-tracking/cancel";
const FINALIZE_URL = "/api/asc/hub-tracking/finalize";

function cppPlan(name: string) {
  return {
    cppName: name,
    deepLinkFile: null,
    locales: [
      {
        locale: "en-US",
        promoTextFile: new File(["Great sale!"], "promo.txt"),
        screenshotFiles: { iphone: [], ipad: [] },
        previewFiles: { iphone: [], ipad: [] },
      },
    ],
  };
}

interface Scenario {
  /** Response for `/start` — a run_id, null (unconfigured/disabled), or a
   *  Promise the test controls manually (for the race-drop test). */
  startResult: Promise<{ run_id: string | null }> | { run_id: string | null };
  /** Per-CPP-name override for the create-CPP call outcome. Missing name
   *  defaults to success. */
  createOutcomes?: Record<string, "ok" | "fail">;
}

function installFetchMock(scenario: Scenario) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.includes(START_URL)) {
      return Promise.resolve(scenario.startResult).then((body) => ({
        ok: true,
        json: async () => body,
      }));
    }
    if (url.includes(CANCEL_URL)) {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    if (url.includes(FINALIZE_URL)) {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    if (url.includes("/app-info-localizations")) {
      return Promise.resolve({ ok: true, json: async () => ({ locales: ["en-US"] }) });
    }
    if (url === "/api/asc/cpps" && method === "POST") {
      const body = JSON.parse(init!.body as string) as { name: string };
      const outcome = scenario.createOutcomes?.[body.name] ?? "ok";
      if (outcome === "fail") {
        return Promise.resolve({ ok: false, json: async () => ({ error: "Apple rejected it" }) });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ data: { id: `cpp-${body.name}` } }),
      });
    }
    if (/\/api\/asc\/cpps\/cpp-/.test(url) && method === "GET") {
      return Promise.resolve({
        ok: true,
        json: async () => ({ versions: [{ version: { id: "v1" }, localizations: [] }] }),
      });
    }
    if (/\/localizations$/.test(url) && method === "POST") {
      return Promise.resolve({ ok: true, json: async () => ({ data: { id: "loc-1" } }) });
    }
    if (url.includes("/screenshot-sets") || url.includes("/preview-sets")) {
      return Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
    }
    return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDialog() {
  const onClose = vi.fn();
  const onComplete = vi.fn();
  const utils = render(
    <CppBulkImportDialog appId="app-1" existingCpps={[]} onClose={onClose} onComplete={onComplete} />,
  );
  return { ...utils, onClose, onComplete };
}

function dropFolder(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error("file input not found");
  const dummy = new File(["x"], "dummy.txt");
  fireEvent.change(input, { target: { files: [dummy] } });
}

async function goToPreview(container: HTMLElement) {
  dropFolder(container);
  await waitFor(() => expect(screen.getByRole("button", { name: /Import All/ })).toBeInTheDocument());
}

function clickImportAll() {
  fireEvent.click(screen.getByRole("button", { name: /Import All/ }));
}

function backdrop(container: HTMLElement): HTMLElement {
  const el = container.querySelector(".bg-black\\/40");
  if (!el) throw new Error("backdrop not found");
  return el as HTMLElement;
}

function parsedBodiesOf(fetchMock: ReturnType<typeof vi.fn>, urlFragment: string): unknown[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes(urlFragment))
    .map((c) => JSON.parse((c[1] as RequestInit).body as string));
}

beforeEach(() => {
  Object.defineProperty(window.navigator, "sendBeacon", {
    value: vi.fn(() => true),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CppBulkImportDialog — Hub tracking terminal status end-to-end", () => {
  it("all CPPs succeeding → finalize POSTed with status SUCCESS and the adopted run_id", async () => {
    parseCppFolderStructureMock.mockReturnValue({
      primaryLocaleFile: null,
      metadataFile: null,
      cpps: [cppPlan("Summer")],
    });
    const fetchMock = installFetchMock({ startResult: { run_id: "run-abc" } });
    const { container } = renderDialog();

    await goToPreview(container);
    // Let the /start response land and be adopted before Import All.
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(START_URL))).toBe(true));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    clickImportAll();
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(FINALIZE_URL))).toBe(true));

    const bodies = parsedBodiesOf(fetchMock, FINALIZE_URL);
    expect(bodies).toEqual([{ run_id: "run-abc", status: "SUCCESS" }]);
  });

  it("all CPPs failing → finalize POSTed with status FAILED and a count-based error_message", async () => {
    parseCppFolderStructureMock.mockReturnValue({
      primaryLocaleFile: null,
      metadataFile: null,
      cpps: [cppPlan("Broken")],
    });
    const fetchMock = installFetchMock({
      startResult: { run_id: "run-1" },
      createOutcomes: { Broken: "fail" },
    });
    const { container } = renderDialog();

    await goToPreview(container);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(START_URL))).toBe(true));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    clickImportAll();
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(FINALIZE_URL))).toBe(true));

    const bodies = parsedBodiesOf(fetchMock, FINALIZE_URL);
    expect(bodies).toEqual([
      { run_id: "run-1", status: "FAILED", error_message: "1/1 CPPs failed" },
    ]);
  });

  it("a mix of success + failure across CPPs → finalize POSTed with status PARTIAL", async () => {
    parseCppFolderStructureMock.mockReturnValue({
      primaryLocaleFile: null,
      metadataFile: null,
      cpps: [cppPlan("Good"), cppPlan("Bad")],
    });
    const fetchMock = installFetchMock({
      startResult: { run_id: "run-2" },
      createOutcomes: { Bad: "fail" },
    });
    const { container } = renderDialog();

    await goToPreview(container);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(START_URL))).toBe(true));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    clickImportAll();
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(FINALIZE_URL))).toBe(true));

    const bodies = parsedBodiesOf(fetchMock, FINALIZE_URL);
    expect(bodies).toEqual([{ run_id: "run-2", status: "PARTIAL" }]);
  });

  it("tracking unconfigured/disabled (run_id: null) → no finalize call at all (no-op, matches the existing no-tracking behavior)", async () => {
    parseCppFolderStructureMock.mockReturnValue({
      primaryLocaleFile: null,
      metadataFile: null,
      cpps: [cppPlan("Summer")],
    });
    const fetchMock = installFetchMock({ startResult: { run_id: null } });
    const { container } = renderDialog();

    await goToPreview(container);
    clickImportAll();
    await waitFor(() => expect(screen.getByText(/Done —/)).toBeInTheDocument());

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(FINALIZE_URL))).toBe(false);
  });
});

describe("CppBulkImportDialog — cancel-guard windows", () => {
  it("closing during 'drop' (before any run has started) sends no cancel call", async () => {
    const fetchMock = installFetchMock({ startResult: { run_id: "run-x" } });
    const { container } = renderDialog();

    fireEvent.click(backdrop(container));

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(CANCEL_URL))).toBe(false);
  });

  it("closing during 'preview' (run started, upload not yet begun) sends a cancel call with the adopted run_id", async () => {
    parseCppFolderStructureMock.mockReturnValue({
      primaryLocaleFile: null,
      metadataFile: null,
      cpps: [cppPlan("Summer")],
    });
    const fetchMock = installFetchMock({ startResult: { run_id: "run-y" } });
    const { container } = renderDialog();

    await goToPreview(container);
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(START_URL))).toBe(true));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(backdrop(container));

    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(CANCEL_URL))).toBe(true));
    const bodies = parsedBodiesOf(fetchMock, CANCEL_URL);
    expect(bodies).toEqual([{ run_id: "run-y" }]);
  });

  it("beforeunload during 'preview' also fires a cancel beacon (same guard as the explicit close)", async () => {
    parseCppFolderStructureMock.mockReturnValue({
      primaryLocaleFile: null,
      metadataFile: null,
      cpps: [cppPlan("Summer")],
    });
    installFetchMock({ startResult: { run_id: "run-z" } });
    const { container } = renderDialog();

    await goToPreview(container);
    await waitFor(() =>
      expect((window.navigator.sendBeacon as ReturnType<typeof vi.fn>).mock).toBeDefined(),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    window.dispatchEvent(new Event("beforeunload"));

    expect(window.navigator.sendBeacon).toHaveBeenCalledWith(
      CANCEL_URL,
      expect.anything(),
    );
  });

  it("beforeunload once upload has started (uploadStartedRef true) sends NO cancel beacon — suppressed", async () => {
    parseCppFolderStructureMock.mockReturnValue({
      primaryLocaleFile: null,
      metadataFile: null,
      cpps: [cppPlan("Summer")],
    });
    installFetchMock({ startResult: { run_id: "run-w" } });
    const { container } = renderDialog();

    await goToPreview(container);
    await waitFor(() => expect(true).toBe(true));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    clickImportAll();
    // Fire beforeunload mid-flight, before the upload phase has settled.
    window.dispatchEvent(new Event("beforeunload"));

    expect(window.navigator.sendBeacon).not.toHaveBeenCalled();
  });
});

describe("CppBulkImportDialog — race-drop hardening (design §1.8/§2.D, mirrors Google IAP's ce169a8)", () => {
  it("a /start response that resolves AFTER upload has begun is never adopted, and the orphan run is best-effort-cancelled once it lands", async () => {
    vi.useFakeTimers();
    parseCppFolderStructureMock.mockReturnValue({
      primaryLocaleFile: null,
      metadataFile: null,
      cpps: [cppPlan("Summer")],
    });

    let resolveStart!: (v: { run_id: string | null }) => void;
    const controlledStart = new Promise<{ run_id: string | null }>((resolve) => {
      resolveStart = resolve;
    });
    const fetchMock = installFetchMock({ startResult: controlledStart });
    const { container } = renderDialog();

    // NOTE: fake timers are active from here on — RTL's `waitFor` polls via
    // real setTimeout, which never fires under fake timers, so this test
    // flushes the microtask queue manually instead (Promise scheduling
    // itself is NOT faked by vi.useFakeTimers — only setTimeout/Date/etc.).
    async function flushMicrotasks(times = 30) {
      for (let i = 0; i < times; i++) {
        await Promise.resolve();
      }
    }

    await act(async () => {
      dropFolder(container);
      await flushMicrotasks();
    });
    expect(screen.getByRole("button", { name: /Import All/ })).toBeInTheDocument();
    // /start has been fired but is still pending — the exact race window.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(START_URL))).toBe(true);

    // Click Import All: the bounded 1s race begins. Advance past the cap —
    // the import must not be blocked waiting on tracking.
    await act(async () => {
      clickImportAll();
      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
    });

    // The cap won — finalize (once upload completes) must use a null
    // run_id, i.e. no finalize call should ever reference the late run.
    await act(async () => {
      await flushMicrotasks();
    });

    // Now the real /start response finally lands with a genuine run_id —
    // this must be treated as an orphan: best-effort cancelled, never
    // adopted, never guessed into finalize's status.
    await act(async () => {
      resolveStart({ run_id: "late-orphan-run" });
      await flushMicrotasks();
    });

    // Switch back to real timers for the tail assertion — everything from
    // here on is already-settled state, not something still waiting on a
    // faked timer.
    vi.useRealTimers();

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (c) => String(c[0]).includes(CANCEL_URL) && String((c[1] as RequestInit).body).includes("late-orphan-run"),
        ),
      ).toBe(true),
    );

    // The orphan run_id must NEVER appear in a finalize call.
    const finalizeBodies = parsedBodiesOf(fetchMock, FINALIZE_URL);
    expect(finalizeBodies.some((b) => (b as { run_id?: string }).run_id === "late-orphan-run")).toBe(false);
  });
});
