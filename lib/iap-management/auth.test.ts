/**
 * Unit tests for IAP auth helpers. Mocks `getServerSession` from next-auth
 * so the helpers can be driven through unauthenticated / member / admin
 * paths without a real session.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import {
  requireIapSession,
  requireIapAdmin,
  IapUnauthorizedError,
  IapForbiddenError,
} from "./auth";

const getServerSessionMock = vi.fn();
vi.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => getServerSessionMock(...args),
}));
vi.mock("@/lib/auth", () => ({
  authOptions: { stub: true },
}));

beforeEach(() => {
  (getServerSessionMock as Mock).mockReset();
});

describe("requireIapSession", () => {
  it("returns the session when user has any role", async () => {
    const session = {
      user: { email: "member@vng.com.vn", role: "member" },
    };
    getServerSessionMock.mockResolvedValueOnce(session);
    const result = await requireIapSession();
    expect(result).toBe(session);
  });

  it("throws IapUnauthorizedError when session is null", async () => {
    getServerSessionMock.mockResolvedValueOnce(null);
    await expect(requireIapSession()).rejects.toBeInstanceOf(
      IapUnauthorizedError,
    );
  });

  it("throws IapUnauthorizedError when user is undefined", async () => {
    getServerSessionMock.mockResolvedValueOnce({});
    await expect(requireIapSession()).rejects.toBeInstanceOf(
      IapUnauthorizedError,
    );
  });

  it("throws IapUnauthorizedError when email is missing", async () => {
    getServerSessionMock.mockResolvedValueOnce({ user: { role: "admin" } });
    await expect(requireIapSession()).rejects.toBeInstanceOf(
      IapUnauthorizedError,
    );
  });
});

describe("requireIapAdmin", () => {
  it("returns the session for admin role", async () => {
    const session = {
      user: { email: "admin@vng.com.vn", role: "admin" },
    };
    getServerSessionMock.mockResolvedValueOnce(session);
    const result = await requireIapAdmin();
    expect(result).toBe(session);
  });

  it("throws IapForbiddenError for member role", async () => {
    getServerSessionMock.mockResolvedValueOnce({
      user: { email: "member@vng.com.vn", role: "member" },
    });
    await expect(requireIapAdmin()).rejects.toBeInstanceOf(IapForbiddenError);
  });

  it("propagates IapUnauthorizedError when session is null (no admin downgrade)", async () => {
    getServerSessionMock.mockResolvedValueOnce(null);
    await expect(requireIapAdmin()).rejects.toBeInstanceOf(IapUnauthorizedError);
  });
});
