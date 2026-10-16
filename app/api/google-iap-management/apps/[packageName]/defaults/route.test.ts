/**
 * D9 [arc-google-missing-purchase-options] — the declare route: the ONLY way an
 * app's currency/language get written, and only as 'declared'.
 *
 * It writes only what the Manager was LOOKING AT: the page sends the app id and
 * the value + source it showed; a switched account (P35) or a value changed in
 * between ⇒ 409, nothing written. After a successful write, nothing may report
 * the declaration as failed (P5).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireGoogleIapAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/auth", async () => {
  class GoogleIapUnauthorizedError extends Error {}
  class GoogleIapForbiddenError extends Error {}
  return { requireGoogleIapAdmin, GoogleIapUnauthorizedError, GoogleIapForbiddenError };
});
import {
  GoogleIapForbiddenError,
  GoogleIapUnauthorizedError,
} from "@/lib/google-iap-management/auth";

const listAccounts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/google-accounts", () => ({ listAccounts }));

const getAppByPackage = vi.hoisted(() => vi.fn());
const getAppDefaults = vi.hoisted(() => vi.fn());
const declareAppDefault = vi.hoisted(() => vi.fn());
const { AppDefaultChangedError } = vi.hoisted(() => ({
  AppDefaultChangedError: class AppDefaultChangedError extends Error {},
}));
vi.mock("@/lib/google-iap-management/repository/apps", () => ({
  getAppByPackage,
  getAppDefaults,
  declareAppDefault,
  AppDefaultChangedError,
}));

const appendAction = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/actions-log", () => ({ appendAction }));

const readActiveAccountId = vi.hoisted(() => vi.fn());
const resolveActiveAccountId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/active-account", () => ({
  readActiveAccountId,
  resolveActiveAccountId,
}));

import { POST } from "./route";

const ctx = { params: { packageName: "com.vnggames.ballisticherotwid" } };
const raw = (body: unknown) =>
  new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
/** What the card sends: the field + new value, and what the page showed. */
const SHOWN = {
  currency: { value: "USD", source: "guessed" },
  language: { value: "en-US", source: "guessed" },
} as const;
const post = (body: { field: string; value: unknown } & Record<string, unknown>) =>
  raw({
    appId: "app-1",
    expected: SHOWN[body.field as keyof typeof SHOWN] ?? SHOWN.currency,
    ...body,
  });

const GUESSED = {
  currency: { value: "USD", source: "guessed" },
  language: { value: "en-US", source: "guessed" },
};

beforeEach(() => {
  requireGoogleIapAdmin.mockReset().mockResolvedValue({ user: { email: "m@vng.com.vn", role: "admin" } });
  listAccounts.mockReset().mockResolvedValue([{ id: "acc1", status: "verified" }]);
  readActiveAccountId.mockReset().mockReturnValue(null);
  resolveActiveAccountId.mockReset().mockReturnValue("acc1");
  getAppByPackage.mockReset().mockResolvedValue({ id: "app-1" });
  getAppDefaults.mockReset().mockResolvedValue(GUESSED);
  declareAppDefault.mockReset().mockResolvedValue(undefined);
  appendAction.mockReset().mockResolvedValue(undefined);
});

describe("POST …/defaults — authorization BEFORE any lookup (P34)", () => {
  it("not signed in ⇒ 401, nothing read or written", async () => {
    requireGoogleIapAdmin.mockRejectedValue(new GoogleIapUnauthorizedError());
    const res = await POST(post({ field: "currency", value: "USD" }), ctx);
    expect(res.status).toBe(401);
    expect(getAppByPackage).not.toHaveBeenCalled();
    expect(declareAppDefault).not.toHaveBeenCalled();
  });

  it("non-admin + an app that does NOT exist ⇒ 403, not 404 (the route is not an oracle)", async () => {
    requireGoogleIapAdmin.mockRejectedValue(new GoogleIapForbiddenError("Admin only"));
    getAppByPackage.mockResolvedValue(null);
    const res = await POST(post({ field: "currency", value: "USD" }), ctx);
    expect(res.status).toBe(403);
    expect(getAppByPackage).not.toHaveBeenCalled();
    expect(declareAppDefault).not.toHaveBeenCalled();
  });
});

describe("POST …/defaults — validation", () => {
  it.each([
    [{ field: "price", value: "USD" }, /field must be one of currency, language/],
    [{ field: "currency", value: "TWDX" }, /not a currency Google Play bills in/],
    [{ field: "currency", value: "" }, /currency value is required/],
    [{ field: "language", value: "en_US" }, /not one of the \d+ Google Play locales this tool supports/],
    [{ field: "language", value: "zh" }, /not one of the \d+ Google Play locales this tool supports/],
  ])("%j ⇒ 400, nothing written", async (body, msg) => {
    const res = await POST(post(body), ctx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(msg);
    expect(declareAppDefault).not.toHaveBeenCalled();
  });

  it.each([
    [{ field: "currency", value: "USD", appId: undefined }],
    [{ field: "currency", value: "USD", expected: undefined }],
    [{ field: "currency", value: "USD", expected: { value: "USD", source: "manual" } }],
  ])("missing / malformed appId or expected ⇒ 400, nothing written (%j)", async (body) => {
    const res = await POST(post(body), ctx);
    expect(res.status).toBe(400);
    expect(getAppByPackage).not.toHaveBeenCalled();
    expect(declareAppDefault).not.toHaveBeenCalled();
  });

  it("unknown app (admin) ⇒ 404, nothing written", async () => {
    getAppByPackage.mockResolvedValue(null);
    const res = await POST(post({ field: "currency", value: "USD" }), ctx);
    expect(res.status).toBe(404);
    expect(declareAppDefault).not.toHaveBeenCalled();
  });
});

describe("POST …/defaults — declare / confirm", () => {
  it("CONFIRM a guessed value (same value) ⇒ declared on THIS row, audited as confirm with the old provenance", async () => {
    getAppDefaults
      .mockResolvedValueOnce(GUESSED)
      .mockResolvedValueOnce({
        ...GUESSED,
        currency: { value: "USD", source: "declared" },
      });
    const res = await POST(post({ field: "currency", value: "usd" }), ctx);
    expect(res.status).toBe(200);
    expect(declareAppDefault).toHaveBeenCalledWith("app-1", "currency", "USD", SHOWN.currency);
    expect(appendAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "APP_DEFAULTS_DECLARE",
        targetId: "app-1",
        payload: expect.objectContaining({
          package_name: "com.vnggames.ballisticherotwid",
          field: "currency",
          value: "USD",
          previous_value: "USD",
          previous_source: "guessed",
          kind: "confirm",
        }),
      }),
    );
    const body = (await res.json()) as { defaults: { currency: { source: string } } };
    expect(body.defaults.currency.source).toBe("declared");
  });

  it("language case is normalised to the list's own spelling (EN-us → en-US), never to a guessed region", async () => {
    const res = await POST(post({ field: "language", value: "EN-us" }), ctx);
    expect(res.status).toBe(200);
    expect(declareAppDefault).toHaveBeenCalledWith("app-1", "language", "en-US", SHOWN.language);
  });

  it("DECLARE a different value ⇒ audited as declare with the value it replaced", async () => {
    const res = await POST(post({ field: "language", value: "zh-TW" }), ctx);
    expect(res.status).toBe(200);
    expect(declareAppDefault).toHaveBeenCalledWith("app-1", "language", "zh-TW", SHOWN.language);
    expect(appendAction).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          field: "language",
          value: "zh-TW",
          previous_value: "en-US",
          kind: "declare",
        }),
      }),
    );
  });

  it("compare-and-set: declareAppDefault is filtered on exactly what the page showed", async () => {
    await POST(post({ field: "currency", value: "TWD" }), ctx);
    expect(declareAppDefault).toHaveBeenCalledWith("app-1", "currency", "TWD", {
      value: "USD",
      source: "guessed",
    });
  });

  it("write failed ⇒ 500, never 'ok'", async () => {
    declareAppDefault.mockRejectedValue(new Error("expected 1 app row updated, got 0"));
    const res = await POST(post({ field: "currency", value: "USD" }), ctx);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { ok?: boolean }).ok).toBeUndefined();
    expect(appendAction).not.toHaveBeenCalled();
  });
});

describe("POST …/defaults — writes only the row and value the Manager was looking at", () => {
  it("resolves the app from the active-account COOKIE, never from the body", async () => {
    readActiveAccountId.mockReturnValue("acc1");
    await POST(post({ field: "currency", value: "USD", accountId: "acc2" }), ctx);
    expect(resolveActiveAccountId).toHaveBeenCalledWith([{ id: "acc1", status: "verified" }], "acc1");
    expect(getAppByPackage).toHaveBeenCalledWith("acc1", "com.vnggames.ballisticherotwid");
  });

  it("the cookie now resolves a DIFFERENT app row (account switched in another tab) ⇒ 409 APP_CHANGED, nothing written", async () => {
    getAppByPackage.mockResolvedValue({ id: "app-of-other-account" });
    const res = await POST(post({ field: "currency", value: "USD" }), ctx);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe("APP_CHANGED");
    expect(declareAppDefault).not.toHaveBeenCalled();
    expect(appendAction).not.toHaveBeenCalled();
  });

  it("someone declared another value since the page loaded ⇒ 409 DEFAULT_CHANGED naming it, nothing written", async () => {
    getAppDefaults.mockResolvedValue({
      ...GUESSED,
      currency: { value: "TWD", source: "declared" },
    });
    // The stale page still shows "USD (guessed)" and clicks Confirm.
    const res = await POST(post({ field: "currency", value: "USD" }), ctx);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe("DEFAULT_CHANGED");
    expect(body.error).toMatch(/now TWD \(declared\)/);
    expect(declareAppDefault).not.toHaveBeenCalled();
    expect(appendAction).not.toHaveBeenCalled();
  });

  it("the value changes between the check and the write (CAS matched 0 rows) ⇒ 409, not audited", async () => {
    declareAppDefault.mockRejectedValue(new AppDefaultChangedError("changed since it was read"));
    const res = await POST(post({ field: "currency", value: "USD" }), ctx);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe("DEFAULT_CHANGED");
    expect(appendAction).not.toHaveBeenCalled();
  });

  it("accounts could not be READ ⇒ 503 — not 'no accounts configured' (D2), nothing written", async () => {
    listAccounts.mockRejectedValue(new Error("connection reset"));
    const res = await POST(post({ field: "currency", value: "USD" }), ctx);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/Could not read Google Console accounts \(connection reset\)/);
    expect(body.error).not.toMatch(/No Google Console accounts configured/);
    expect(getAppByPackage).not.toHaveBeenCalled();
    expect(declareAppDefault).not.toHaveBeenCalled();
  });

  it("write OK but the re-read fails ⇒ 200 ok (the value IS declared), defaults null + reread_error (P5)", async () => {
    getAppDefaults
      .mockResolvedValueOnce(GUESSED)
      .mockRejectedValueOnce(new Error("timeout"));
    const res = await POST(post({ field: "currency", value: "USD" }), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; defaults?: unknown; reread_error?: string };
    expect(body.ok).toBe(true);
    expect(body.defaults).toBeNull();
    expect(body.reread_error).toMatch(/timeout/);
    expect(declareAppDefault).toHaveBeenCalledTimes(1);
  });

  it("the read BEFORE the write fails ⇒ 500 and nothing written", async () => {
    getAppDefaults.mockRejectedValue(new Error("column does not exist"));
    const res = await POST(post({ field: "currency", value: "USD" }), ctx);
    expect(res.status).toBe(500);
    expect(declareAppDefault).not.toHaveBeenCalled();
  });
});
