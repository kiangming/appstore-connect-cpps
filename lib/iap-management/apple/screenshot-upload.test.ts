/**
 * uploadScreenshotToApple — 3-step orchestration tests.
 *
 * Mocks the underlying client primitives so each step's success/failure can
 * be exercised independently. Verifies the typed result shape (stage tag on
 * failure, apple_screenshot_id propagation when reserve already succeeded).
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  type Mock,
} from "vitest";
import * as client from "./client";
import * as fetchModule from "./fetch";
import { uploadScreenshotToApple } from "./screenshot-upload";
import type { AscCredentials } from "@/lib/asc-jwt";

vi.mock("./client", () => ({
  reserveInAppPurchaseScreenshot: vi.fn(),
  uploadScreenshotToOperations: vi.fn(),
  confirmInAppPurchaseScreenshot: vi.fn(),
}));

vi.mock("./fetch", async () => {
  const actual =
    await vi.importActual<typeof import("./fetch")>("./fetch");
  return {
    ...actual,
    // Pass-through so the orchestration runs but the inner mocks still fire.
    withRetry: vi.fn((fn: () => unknown) => fn()),
  };
});

const reserve = client.reserveInAppPurchaseScreenshot as unknown as Mock;
const uploadOps = client.uploadScreenshotToOperations as unknown as Mock;
const confirm = client.confirmInAppPurchaseScreenshot as unknown as Mock;
const withRetry = fetchModule.withRetry as unknown as Mock;

const creds: AscCredentials = {
  id: "test",
  name: "Test",
  keyId: "K",
  issuerId: "I",
  privateKey: "P",
};

function fakeFile(): File {
  return new File([new Uint8Array([1, 2, 3, 4])], "shot.jpg", {
    type: "image/jpeg",
  });
}

const goodReserveResponse = {
  data: {
    id: "scr-1",
    attributes: {
      uploadOperations: [
        {
          method: "PUT",
          url: "https://cdn.apple/upload",
          offset: 0,
          length: 4,
          requestHeaders: [],
        },
      ],
    },
  },
};

beforeEach(() => {
  reserve.mockReset();
  uploadOps.mockReset();
  confirm.mockReset();
  withRetry.mockClear();
  withRetry.mockImplementation((fn: () => unknown) => fn());
});

describe("uploadScreenshotToApple — happy path", () => {
  it("returns ok=true with apple_screenshot_id when all 3 steps succeed", async () => {
    reserve.mockResolvedValue(goodReserveResponse);
    uploadOps.mockResolvedValue(undefined);
    confirm.mockResolvedValue({ data: { id: "scr-1" } });

    const result = await uploadScreenshotToApple(creds, "apple-iap-1", fakeFile());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.apple_screenshot_id).toBe("scr-1");
      expect(result.file_name).toBe("shot.jpg");
      expect(result.file_size).toBe(4);
    }
    expect(reserve).toHaveBeenCalledOnce();
    expect(uploadOps).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
  });
});

describe("uploadScreenshotToApple — failure modes", () => {
  it("surfaces reserve failure with stage='reserve'", async () => {
    reserve.mockRejectedValue(new Error("Apple 422: bad metadata"));

    const result = await uploadScreenshotToApple(creds, "apple-iap-1", fakeFile());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("reserve");
      expect(result.error).toContain("bad metadata");
      expect(result.apple_screenshot_id).toBeUndefined();
    }
    expect(uploadOps).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("surfaces empty uploadOperations as a reserve-stage failure with id", async () => {
    reserve.mockResolvedValue({
      data: {
        id: "scr-2",
        attributes: { uploadOperations: [] },
      },
    });

    const result = await uploadScreenshotToApple(creds, "apple-iap-1", fakeFile());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("reserve");
      expect(result.error).toContain("uploadOperations");
      expect(result.apple_screenshot_id).toBe("scr-2");
    }
  });

  it("surfaces upload failure with stage='upload' and propagates apple_screenshot_id", async () => {
    reserve.mockResolvedValue(goodReserveResponse);
    uploadOps.mockRejectedValue(new Error("chunk 0 failed: 500"));

    const result = await uploadScreenshotToApple(creds, "apple-iap-1", fakeFile());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("upload");
      expect(result.error).toContain("chunk 0 failed");
      expect(result.apple_screenshot_id).toBe("scr-1");
    }
    expect(confirm).not.toHaveBeenCalled();
  });

  it("surfaces confirm failure with stage='confirm' and propagates apple_screenshot_id", async () => {
    reserve.mockResolvedValue(goodReserveResponse);
    uploadOps.mockResolvedValue(undefined);
    confirm.mockRejectedValue(new Error("checksum mismatch"));

    const result = await uploadScreenshotToApple(creds, "apple-iap-1", fakeFile());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("confirm");
      expect(result.error).toContain("checksum");
      expect(result.apple_screenshot_id).toBe("scr-1");
    }
  });
});
