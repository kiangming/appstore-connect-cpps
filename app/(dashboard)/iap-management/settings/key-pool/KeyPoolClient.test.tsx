// @vitest-environment jsdom

/**
 * [POOL-key-management-UI] U2 — the Settings screen.
 *
 * Four of these guard properties that are easy to regress into bugs that look
 * fine on screen: a `.p8` left in component state, a disabled key hidden
 * instead of labelled, an account dropdown that drops the issuer, and a green
 * tick rendered for a response that was not a success.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { KeyPoolClient } from "./KeyPoolClient";

afterEach(cleanup);

const PEM = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";

const ACCOUNTS = [
  { id: "acct-a", name: "Account A", issuerId: "issuer-A" },
  // ⚠ B and C deliberately share an issuer — the shared-team case.
  { id: "acct-b", name: "Account B", issuerId: "issuer-SHARED" },
  { id: "acct-c", name: "Account C", issuerId: "issuer-SHARED" },
];

const HOUR = 60 * 60 * 1000;
const keyRow = (over: Record<string, unknown> = {}) => ({
  id: "row-1",
  accountId: "acct-a",
  keyId: "AAAA1111",
  enabled: true,
  cooldownUntil: null,
  createdAt: "2026-08-26T07:00:00.000Z",
  note: "pool key 1",
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;

function installFetch(handlers: Record<string, () => unknown>) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${String(url)}`;
    for (const [pattern, make] of Object.entries(handlers)) {
      if (key.startsWith(pattern)) {
        const body = make();
        const status = (body as { __status?: number }).__status ?? 200;
        return { ok: status >= 200 && status < 300, status, json: async () => body };
      }
    }
    throw new Error(`unexpected fetch: ${key}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

const listOk = (keys: unknown[] = [keyRow()]) => () => ({ keys, accounts: ACCOUNTS });

beforeEach(() => {
  vi.restoreAllMocks();
  installFetch({ "GET /api/iap-management/pool-keys": listOk() });
});

async function renderReady(isAdmin = true) {
  const utils = render(<KeyPoolClient isAdmin={isAdmin} />);
  if (isAdmin) await screen.findByTestId("key-row-AAAA1111");
  return utils;
}

// ─── admin gate (client half) ───────────────────────────────────────────────

describe("the screen is admin-only on the client too", () => {
  it("a non-admin sees an explanation, not the table", async () => {
    render(<KeyPoolClient isAdmin={false} />);
    expect(screen.getByTestId("not-admin")).toBeTruthy();
    expect(screen.queryByTestId("open-add")).toBeNull();
  });

  it("⚠ and it does not even fetch — the server is still the real boundary", () => {
    render(<KeyPoolClient isAdmin={false} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── (b) statuses are shown, never hidden ───────────────────────────────────

describe("⚠ (b) every key is listed, with its state on the row", () => {
  it("shows a disabled key rather than dropping it", async () => {
    installFetch({
      "GET /api/iap-management/pool-keys": listOk([
        keyRow(),
        keyRow({ id: "row-2", keyId: "BBBB2222", enabled: false }),
      ]),
    });
    await renderReady();
    expect(screen.getByTestId("key-row-BBBB2222")).toBeTruthy();
    expect(screen.getByTestId("status-BBBB2222").textContent).toBe("disabled");
  });

  it("⚠ shows a cooling-down key as cooling, not as healthy", async () => {
    installFetch({
      "GET /api/iap-management/pool-keys": listOk([
        keyRow({ cooldownUntil: new Date(Date.now() + HOUR).toISOString() }),
      ]),
    });
    await renderReady();
    expect(screen.getByTestId("status-AAAA1111").textContent).toBe("cooling down");
  });

  it("⚠ a cooldown in the PAST is not a cooldown", async () => {
    // The column is a timestamp so "until when" is answerable; a lapsed
    // deadline means the key is back in rotation.
    installFetch({
      "GET /api/iap-management/pool-keys": listOk([
        keyRow({ cooldownUntil: new Date(Date.now() - HOUR).toISOString() }),
      ]),
    });
    await renderReady();
    expect(screen.getByTestId("status-AAAA1111").textContent).toBe("enabled");
  });

  it("⚠ an account with no keys is still listed, with an explanation", async () => {
    // Hiding it would make "not pooled yet" — the normal state — look
    // identical to "this account does not exist".
    await renderReady();
    expect(screen.getByTestId("account-group-acct-b")).toBeTruthy();
    expect(screen.getByTestId("empty-acct-b").textContent).toMatch(/chưa có pool key/);
  });

  it("shows the key id in full (Q2)", async () => {
    await renderReady();
    const row = screen.getByTestId("key-row-AAAA1111");
    expect(row.textContent).toContain("AAAA1111");
  });
});

// ─── (c) the dropdown carries the issuer ────────────────────────────────────

describe("⚠ (c) the account dropdown exposes the issuer", () => {
  it("every option names its issuer", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("open-add"));
    const select = screen.getByTestId("account-select");
    const opts = [...select.querySelectorAll("option")].map((o) => o.textContent ?? "");
    expect(opts.some((t) => t.includes("issuer-A"))).toBe(true);
    expect(opts.filter((t) => t.includes("issuer-SHARED"))).toHaveLength(2);
  });

  it("⚠ warns when the chosen account shares a team with another", async () => {
    // Losing this is how the same key gets seeded twice against one real
    // budget while the table looks like added headroom.
    await renderReady();
    fireEvent.click(screen.getByTestId("open-add"));
    expect(screen.queryByTestId("shared-issuer-warning")).toBeNull();
    fireEvent.change(screen.getByTestId("account-select"), { target: { value: "acct-b" } });
    expect(screen.getByTestId("shared-issuer-warning")).toBeTruthy();
  });

  it("does not warn for an account with a unique issuer", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("open-add"));
    fireEvent.change(screen.getByTestId("account-select"), { target: { value: "acct-a" } });
    expect(screen.queryByTestId("shared-issuer-warning")).toBeNull();
  });

  it("the options come from the API, not a constant", async () => {
    installFetch({
      "GET /api/iap-management/pool-keys": () => ({
        keys: [keyRow()],
        accounts: [{ id: "only-one", name: "Only One", issuerId: "iss-1" }],
      }),
    });
    render(<KeyPoolClient isAdmin />);
    await screen.findByTestId("account-group-only-one");
    fireEvent.click(screen.getByTestId("open-add"));
    const opts = [...screen.getByTestId("account-select").querySelectorAll("option")];
    expect(opts.map((o) => o.textContent).join()).toContain("Only One");
    expect(opts.map((o) => o.textContent).join()).not.toContain("Account A");
  });
});

// ─── (a) the .p8 does not linger ────────────────────────────────────────────

describe("⚠ (a) the private key does not stay in client state", () => {
  async function fillAndSubmit() {
    await renderReady();
    fireEvent.click(screen.getByTestId("open-add"));
    fireEvent.change(screen.getByTestId("account-select"), { target: { value: "acct-a" } });
    fireEvent.change(screen.getByTestId("key-id-input"), { target: { value: "NEWKEY123" } });
    fireEvent.change(screen.getByTestId("p8-input"), { target: { value: PEM } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("submit-add"));
    });
  }

  it("⚠ the textarea is empty after a successful add", async () => {
    installFetch({
      "GET /api/iap-management/pool-keys": listOk(),
      "POST /api/iap-management/pool-keys": () => ({ ok: true, keys: [keyRow()] }),
    });
    await fillAndSubmit();
    await waitFor(() => expect(screen.queryByTestId("p8-input")).toBeNull());
    // Re-open: state must be blank, not repopulated from memory.
    fireEvent.click(screen.getByTestId("open-add"));
    expect((screen.getByTestId("p8-input") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByTestId("key-id-input") as HTMLInputElement).value).toBe("");
  });

  it("⚠ cancelling also clears it — an abandoned form must not keep the key", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("open-add"));
    fireEvent.change(screen.getByTestId("p8-input"), { target: { value: PEM } });
    fireEvent.click(screen.getByText("Huỷ"));
    fireEvent.click(screen.getByTestId("open-add"));
    expect((screen.getByTestId("p8-input") as HTMLTextAreaElement).value).toBe("");
  });

  it("⚠ a FAILED add keeps the key so the operator can retry", async () => {
    // The opposite requirement, and it matters: wiping the form on a 409
    // would make the Manager re-paste a .p8 they may have already filed away.
    installFetch({
      "GET /api/iap-management/pool-keys": listOk(),
      "POST /api/iap-management/pool-keys": () => ({ __status: 409, error: "đã tồn tại" }),
    });
    await fillAndSubmit();
    expect(screen.getByTestId("form-error").textContent).toContain("đã tồn tại");
    expect((screen.getByTestId("p8-input") as HTMLTextAreaElement).value).toBe(PEM);
  });

  it("rejects a non-PEM paste before sending anything", async () => {
    await renderReady();
    fireEvent.click(screen.getByTestId("open-add"));
    fireEvent.change(screen.getByTestId("account-select"), { target: { value: "acct-a" } });
    fireEvent.change(screen.getByTestId("key-id-input"), { target: { value: "K" } });
    fireEvent.change(screen.getByTestId("p8-input"), { target: { value: "nope" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("submit-add"));
    });
    expect(screen.getByTestId("form-error").textContent).toMatch(/BEGIN PRIVATE KEY/);
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(0);
  });
});

// ─── (d) Test key renders the right verdict ─────────────────────────────────

describe("⚠ (d) Test key never shows success for a non-success", () => {
  async function clickTest(response: Record<string, unknown>) {
    installFetch({
      "GET /api/iap-management/pool-keys": listOk(),
      "POST /api/iap-management/pool-keys/row-1/test": () => response,
    });
    await renderReady();
    await act(async () => {
      fireEvent.click(screen.getByTestId("test-AAAA1111"));
    });
  }

  it("✅ renders the budget on a real success", async () => {
    await clickTest({ ok: true, kind: "OK", keyId: "AAAA1111", accountName: "Account A", remaining: 3599, limit: 3600 });
    const box = await screen.findByTestId("test-ok");
    expect(box.textContent).toContain("3599");
    expect(box.textContent).toContain("3600");
    expect(box.textContent).toContain("Account A");
  });

  it("⚠ ❌ a wrong-team result names the account and is NOT the ok box", async () => {
    await clickTest({ ok: false, kind: "WRONG_TEAM", keyId: "AAAA1111", accountName: "Account A", error: "Apple trả 401." });
    expect(await screen.findByTestId("test-wrong-team")).toBeTruthy();
    expect(screen.queryByTestId("test-ok")).toBeNull();
  });

  it("⚠ a 503 is 'not verified', NOT 'wrong key'", async () => {
    // Telling an operator to re-register a good key because Apple had a bad
    // minute is the expensive mistake.
    await clickTest({ ok: false, kind: "UNKNOWN", keyId: "AAAA1111", accountName: "Account A", error: "Apple 503" });
    const box = await screen.findByTestId("test-unknown");
    expect(box.textContent).toMatch(/không phải kết luận key sai/);
    expect(screen.queryByTestId("test-ok")).toBeNull();
    expect(screen.queryByTestId("test-wrong-team")).toBeNull();
  });

  it("⚠ a route-level failure surfaces readably, not as a fake verdict", async () => {
    await clickTest({ __status: 403, error: "Admin role required" });
    expect(await screen.findByTestId("row-error")).toBeTruthy();
    expect(screen.getByTestId("row-error").textContent).toContain("Admin role required");
    expect(screen.queryByTestId("test-ok")).toBeNull();
  });

  it("shows a loading state while Apple is being asked", async () => {
    let release: (v: unknown) => void = () => {};
    const pending = new Promise((r) => { release = r; });
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return { ok: true, status: 200, json: async () => ({ keys: [keyRow()], accounts: ACCOUNTS }) };
      }
      await pending;
      return { ok: true, status: 200, json: async () => ({ ok: true, kind: "OK", keyId: "AAAA1111", accountName: "Account A", remaining: 1, limit: 2 }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    await renderReady();
    fireEvent.click(screen.getByTestId("test-AAAA1111"));
    await waitFor(() => expect(screen.getByTestId("test-AAAA1111").textContent).toContain("Đang kiểm…"));
    await act(async () => { release(null); });
  });
});

// ─── (5) API errors are readable ────────────────────────────────────────────

describe("API errors are shown, not swallowed", () => {
  it("a 403 on load explains itself", async () => {
    installFetch({ "GET /api/iap-management/pool-keys": () => ({ __status: 403, error: "Admin role required" }) });
    render(<KeyPoolClient isAdmin />);
    expect((await screen.findByTestId("load-error")).textContent).toContain("Admin role required");
  });

  it("a validation error from the server reaches the form", async () => {
    installFetch({
      "GET /api/iap-management/pool-keys": listOk(),
      "POST /api/iap-management/pool-keys": () => ({ __status: 400, error: 'Account "ghost" không tồn tại.' }),
    });
    await renderReady();
    fireEvent.click(screen.getByTestId("open-add"));
    fireEvent.change(screen.getByTestId("account-select"), { target: { value: "acct-a" } });
    fireEvent.change(screen.getByTestId("key-id-input"), { target: { value: "K" } });
    fireEvent.change(screen.getByTestId("p8-input"), { target: { value: PEM } });
    await act(async () => { fireEvent.click(screen.getByTestId("submit-add")); });
    expect(screen.getByTestId("form-error").textContent).toContain("không tồn tại");
  });

  it("a toggle failure is reported", async () => {
    installFetch({
      "GET /api/iap-management/pool-keys": listOk(),
      "PATCH /api/iap-management/pool-keys/row-1": () => ({ __status: 500, error: "DB down" }),
    });
    await renderReady();
    await act(async () => { fireEvent.click(screen.getByTestId("toggle-AAAA1111")); });
    expect(screen.getByTestId("row-error").textContent).toContain("DB down");
  });
});
