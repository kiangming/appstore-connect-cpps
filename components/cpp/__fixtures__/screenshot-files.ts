/**
 * Test-only helpers for screenshot-size tests (arc
 * `[CPP-bulkimport-ipad-screenshot-sizes]`, design
 * docs/cpp-management/design-cpp-bulkimport-ipad-screenshot-sizes.md §P5).
 *
 * jsdom cannot decode images, so `installFakeImage` replaces `Image` with a
 * stub that reports the size written in the FILE NAME (`…-2064x2752.png`).
 * The code under test still runs its real path: `URL.createObjectURL(file)` →
 * `new Image()` → `img.src = url` → `onload` → `naturalWidth/naturalHeight`.
 * A name containing `corrupt` fires `onerror` instead.
 */
import { vi } from "vitest";

const SIZE_IN_NAME = /(\d+)x(\d+)/;

export function installFakeImage(): void {
  const urlToName = new Map<string, string>();
  let seq = 0;
  URL.createObjectURL = (obj: Blob | MediaSource) => {
    const url = `blob:fake-${seq++}`;
    urlToName.set(url, obj instanceof File ? obj.name : "");
    return url;
  };
  URL.revokeObjectURL = () => {};

  class FakeImage {
    naturalWidth = 0;
    naturalHeight = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(url: string) {
      const name = urlToName.get(url) ?? "";
      const m = SIZE_IN_NAME.exec(name);
      if (!m || name.includes("corrupt")) {
        queueMicrotask(() => this.onerror?.());
        return;
      }
      this.naturalWidth = Number(m[1]);
      this.naturalHeight = Number(m[2]);
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("Image", FakeImage);
}

/** A File whose `webkitRelativePath` is `path` and whose name is the last segment. */
export function fileAt(path: string): File {
  const f = new File(["x"], path.split("/").pop() ?? path, { type: "image/png" });
  Object.defineProperty(f, "webkitRelativePath", { value: path });
  return f;
}
