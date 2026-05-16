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
import {
  uploadScreenshotToApple,
  replaceScreenshotOnApple,
} from "./screenshot-upload";
import { AppleApiError } from "./fetch";
import type { AscCredentials } from "@/lib/asc-jwt";

vi.mock("./client", () => ({
  reserveInAppPurchaseScreenshot: vi.fn(),
  uploadScreenshotToOperations: vi.fn(),
  confirmInAppPurchaseScreenshot: vi.fn(),
  deleteInAppPurchaseScreenshot: vi.fn(),
  getInAppPurchase: vi.fn(),
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
const deleteScreenshot =
  client.deleteInAppPurchaseScreenshot as unknown as Mock;
const getIap = client.getInAppPurchase as unknown as Mock;
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
  deleteScreenshot.mockReset();
  getIap.mockReset();
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

// IAP.o.8a — replace orchestration covers the OVERWRITE path: detect an
// existing screenshot, DELETE it (when present), then run the 3-step. The
// 409 path is the critical Manager-trust edge — Apple locks the screenshot
// on IAPs in WAITING_FOR_REVIEW / IN_REVIEW; the orchestrator surfaces
// `delete-locked` non-fatally so the import row stays SUCCESS with a hint
// instead of failing the whole entry.
describe("replaceScreenshotOnApple", () => {
  function iapWithScreenshot(screenshotId: string | null) {
    return {
      data: {
        id: "apple-iap-1",
        type: "inAppPurchases",
        attributes: {},
        relationships: {
          reviewScreenshot: screenshotId
            ? { data: { type: "inAppPurchaseReviewScreenshots", id: screenshotId } }
            : { data: null },
        },
      },
    };
  }

  it("deletes existing screenshot then runs 3-step on success", async () => {
    getIap.mockResolvedValue(iapWithScreenshot("scr-old"));
    deleteScreenshot.mockResolvedValue(undefined);
    reserve.mockResolvedValue(goodReserveResponse);
    uploadOps.mockResolvedValue(undefined);
    confirm.mockResolvedValue({ data: { id: "scr-1" } });

    const result = await replaceScreenshotOnApple(
      creds,
      "apple-iap-1",
      fakeFile(),
    );

    expect(result.ok).toBe(true);
    expect(deleteScreenshot).toHaveBeenCalledWith(creds, "scr-old");
    expect(reserve).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("skips DELETE when no screenshot is currently attached", async () => {
    getIap.mockResolvedValue(iapWithScreenshot(null));
    reserve.mockResolvedValue(goodReserveResponse);
    uploadOps.mockResolvedValue(undefined);
    confirm.mockResolvedValue({ data: { id: "scr-1" } });

    const result = await replaceScreenshotOnApple(
      creds,
      "apple-iap-1",
      fakeFile(),
    );

    expect(result.ok).toBe(true);
    expect(deleteScreenshot).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenCalledOnce();
  });

  it("returns stage='delete-locked' on Apple 409 without aborting", async () => {
    getIap.mockResolvedValue(iapWithScreenshot("scr-old"));
    deleteScreenshot.mockRejectedValue(
      new AppleApiError(
        409,
        "DELETE",
        "/v1/inAppPurchaseReviewScreenshots/scr-old",
        "IAP is in review",
      ),
    );

    const result = await replaceScreenshotOnApple(
      creds,
      "apple-iap-1",
      fakeFile(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("delete-locked");
      expect(result.apple_screenshot_id).toBe("scr-old");
    }
    // The 3-step must NOT have run after a locked DELETE.
    expect(reserve).not.toHaveBeenCalled();
  });

  it("returns stage='delete' on non-409 DELETE failure", async () => {
    getIap.mockResolvedValue(iapWithScreenshot("scr-old"));
    deleteScreenshot.mockRejectedValue(
      new AppleApiError(
        500,
        "DELETE",
        "/v1/inAppPurchaseReviewScreenshots/scr-old",
        "Internal Server Error",
      ),
    );

    const result = await replaceScreenshotOnApple(
      creds,
      "apple-iap-1",
      fakeFile(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("delete");
      expect(result.apple_screenshot_id).toBe("scr-old");
    }
    expect(reserve).not.toHaveBeenCalled();
  });

  it("returns stage='lookup' when getInAppPurchase fails", async () => {
    getIap.mockRejectedValue(new Error("Network down"));

    const result = await replaceScreenshotOnApple(
      creds,
      "apple-iap-1",
      fakeFile(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("lookup");
      expect(result.error).toContain("Network");
    }
    expect(deleteScreenshot).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("propagates 3-step upload failures after a successful DELETE", async () => {
    getIap.mockResolvedValue(iapWithScreenshot("scr-old"));
    deleteScreenshot.mockResolvedValue(undefined);
    reserve.mockResolvedValue(goodReserveResponse);
    uploadOps.mockRejectedValue(new Error("chunk 0 failed: 500"));

    const result = await replaceScreenshotOnApple(
      creds,
      "apple-iap-1",
      fakeFile(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("upload");
    }
    expect(deleteScreenshot).toHaveBeenCalledOnce();
  });
});
