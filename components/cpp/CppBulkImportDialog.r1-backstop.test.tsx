// @vitest-environment jsdom

/**
 * Dedicated suite for R1 (finalize-in-finally) — an UNEXPECTED exception
 * during the upload phase's try block (distinct from the CPP-level
 * try/catch inside uploadCpp/uploadLocale itself). This is a separate
 * file, not folded into CppBulkImportDialog.test.tsx, because it needs to
 * mock `@/lib/cpp-hub-tracking/status-mapping` — the main suite relies on
 * the REAL `computeBulkImportTerminalStatus`, so mocking it there would
 * contaminate every other test in that file (vi.mock is hoisted
 * file-wide, not scoped per-test).
 *
 * `computeBulkImportTerminalStatus` is forced to throw here — it's called
 * inside the SAME try block as `await Promise.all([worker(), worker()])`
 * in CppBulkImportDialog.tsx's startUpload, so this exercises the exact
 * catch/finally statement R1 protects, not a contrived stand-in for it.
 * `deriveTerminalStatusOnUnexpectedError` is left as the REAL
 * implementation (via importActual) so the test proves the actual R1
 * backstop logic runs, not a mocked stand-in for it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const parseCppFolderStructureMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/parseCppFolderStructure", () => ({
  parseCppFolderStructure: parseCppFolderStructureMock,
}));

vi.mock("@/lib/cpp-hub-tracking/status-mapping", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cpp-hub-tracking/status-mapping")>(
    "@/lib/cpp-hub-tracking/status-mapping",
  );
  return {
    ...actual,
    // The NORMAL-path status computer — forced to throw so startUpload's
    // try block fails AFTER Promise.all has already resolved successfully,
    // simulating "Promise.all-scope throws unexpectedly" without needing
    // to fight React internals or the single-threaded worker-queue timing.
    computeBulkImportTerminalStatus: () => {
      throw new Error("INJECTED: unexpected status computation failure");
    },
  };
});

import { CppBulkImportDialog } from "./CppBulkImportDialog";

const START_URL = "/api/asc/hub-tracking/start";
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

function installFetchMock() {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.includes(START_URL)) {
      return Promise.resolve({ ok: true, json: async () => ({ run_id: "run-r1" }) });
    }
    if (url.includes("/api/asc/hub-tracking/cancel")) {
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
      return Promise.resolve({ ok: true, json: async () => ({ data: { id: `cpp-${body.name}` } }) });
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
  return render(
    <CppBulkImportDialog appId="app-1" existingCpps={[]} onClose={onClose} onComplete={onComplete} />,
  );
}

function dropFolder(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error("file input not found");
  fireEvent.change(input, { target: { files: [new File(["x"], "dummy.txt")] } });
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
});

describe("R1 — finalize-in-finally: an unexpected exception during the upload phase's try block", () => {
  it("still finalizes the run (never left RUNNING), deriving FAILED/PARTIAL from what actually completed — not a guessed SUCCESS, not silently swallowed", async () => {
    parseCppFolderStructureMock.mockReturnValue({
      primaryLocaleFile: null,
      metadataFile: null,
      cpps: [cppPlan("Summer")],
    });
    const fetchMock = installFetchMock();
    const { container } = renderDialog();

    dropFolder(container);
    await waitFor(() => expect(screen.getByRole("button", { name: /Import All/ })).toBeInTheDocument());
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(START_URL))).toBe(true));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The single CPP upload itself succeeds normally (succeededCount → 1)
    // — the injected failure is ONLY in the post-upload status computation,
    // so a real, distinguishable success count reaches the R1 backstop.
    fireEvent.click(screen.getByRole("button", { name: /Import All/ }));

    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(FINALIZE_URL))).toBe(true));

    const bodies = parsedBodiesOf(fetchMock, FINALIZE_URL) as Array<{
      run_id: string;
      status: string;
      error_message?: string;
    }>;
    expect(bodies).toHaveLength(1);
    // succeededCount (1) > 0 at the moment of the injected throw →
    // deriveTerminalStatusOnUnexpectedError maps this to PARTIAL, never
    // SUCCESS (what the broken normal-path computer would have said had it
    // not thrown) and never silently absent (what a swallowed/uncaught
    // exception would produce — no finalize call at all).
    expect(bodies[0].status).toBe("PARTIAL");
    expect(bodies[0].run_id).toBe("run-r1");
    expect(bodies[0].error_message).toContain("INJECTED: unexpected status computation failure");

    // The dialog must still reach "done" — the throw must not leave the UI
    // stuck on "uploading" either.
    await waitFor(() => expect(screen.getByText(/Done —/)).toBeInTheDocument());
  });
});
