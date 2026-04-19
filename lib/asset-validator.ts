"use client";

/**
 * Asset validation for App Store Connect screenshots and app preview videos.
 *
 * Config: NEXT_PUBLIC_ASSET_VALIDATION_DEEP=true (default)
 *   true  → full validation via ffmpeg.wasm (FPS, bitrate, audio codec, etc.)
 *   false → basic validation only (resolution, duration, size, format) + checklist warnings
 */

export type DeviceType = "iphone" | "ipad";

export interface ValidationResult {
  ok: boolean;
  errors: string[];    // Hard errors — block upload
  warnings: string[];  // Soft reminders — shown only in basic mode
}

// ── Screenshot rules ──────────────────────────────────────────────────────────

const SCREENSHOT_SIZES: Record<DeviceType, Array<{ w: number; h: number }>> = {
  iphone: [
    { w: 1284, h: 2778 }, { w: 2778, h: 1284 },
    { w: 1242, h: 2688 }, { w: 2688, h: 1242 },
  ],
  ipad: [
    { w: 2064, h: 2752 }, { w: 2752, h: 2064 },
    { w: 2048, h: 2732 }, { w: 2732, h: 2048 },
  ],
};

export const SCREENSHOT_LIMITS: Record<DeviceType, { min: number; max: number }> = {
  iphone: { min: 3, max: 10 },
  ipad:   { min: 3, max: 10 },
};

// ── Video rules ───────────────────────────────────────────────────────────────

const VIDEO_SIZES: Record<DeviceType, Array<{ w: number; h: number }>> = {
  iphone: [{ w: 886, h: 1920 }, { w: 1920, h: 886 }],
  ipad:   [{ w: 1200, h: 1600 }, { w: 1600, h: 1200 }],
};

const VIDEO_FORMATS = [".m4v", ".mp4", ".mov"];
const VIDEO_MAX_COUNT = 3;
const VIDEO_MIN_DURATION = 15;
const VIDEO_MAX_DURATION = 30;
const VIDEO_MAX_SIZE_MB = 500;
const VIDEO_MAX_FPS = 30;
const VIDEO_BITRATE_MIN_KBPS = 10_000;
const VIDEO_BITRATE_MAX_KBPS = 12_000;

export const BASIC_MODE_WARNINGS = [
  "FPS ≤ 30",
  "Bitrate 10–12 Mbps",
  "Audio: AAC 256kbps, Stereo, 44.1kHz or 48kHz",
  "Stereo config: 1 track 2-ch (L+R) or 2 tracks 1-ch (L, R)",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function isDeepMode(): boolean {
  return process.env.NEXT_PUBLIC_ASSET_VALIDATION_DEEP !== "false";
}

function getImageDimensions(file: File): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Cannot read image dimensions"));
    };
    img.src = url;
  });
}

function getVideoBasicInfo(file: File): Promise<{ w: number; h: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve({ w: video.videoWidth, h: video.videoHeight, duration: video.duration });
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Cannot read video metadata"));
    };
    video.src = url;
  });
}

function matchesSize(
  actual: { w: number; h: number },
  validSizes: Array<{ w: number; h: number }>
): boolean {
  return validSizes.some((s) => s.w === actual.w && s.h === actual.h);
}

function formatValidSizes(sizes: Array<{ w: number; h: number }>): string {
  return sizes.map((s) => `${s.w}×${s.h}`).join(", ");
}

// ── Screenshot validation ─────────────────────────────────────────────────────

export async function validateScreenshot(
  file: File,
  device: DeviceType
): Promise<ValidationResult> {
  const errors: string[] = [];

  try {
    const { w, h } = await getImageDimensions(file);
    const validSizes = SCREENSHOT_SIZES[device];

    if (!matchesSize({ w, h }, validSizes)) {
      errors.push(
        `Resolution: got ${w}×${h} — expected one of: ${formatValidSizes(validSizes)}`
      );
    }
  } catch {
    errors.push("Cannot read image file — file may be corrupted");
  }

  return { ok: errors.length === 0, errors, warnings: [] };
}

// ── Video validation — basic ──────────────────────────────────────────────────

async function validateVideoBasic(file: File, device: DeviceType): Promise<ValidationResult> {
  const errors: string[] = [];

  // Format check
  const ext = "." + file.name.split(".").pop()?.toLowerCase();
  if (!VIDEO_FORMATS.includes(ext)) {
    errors.push(`Format: "${ext}" not allowed — use ${VIDEO_FORMATS.join(", ")}`);
  }

  // File size
  const sizeMB = file.size / (1024 * 1024);
  if (sizeMB > VIDEO_MAX_SIZE_MB) {
    errors.push(`File size: ${sizeMB.toFixed(0)}MB — max ${VIDEO_MAX_SIZE_MB}MB`);
  }

  // Resolution + duration via browser
  try {
    const { w, h, duration } = await getVideoBasicInfo(file);
    const validSizes = VIDEO_SIZES[device];

    if (!matchesSize({ w, h }, validSizes)) {
      errors.push(
        `Resolution: got ${w}×${h} — expected one of: ${formatValidSizes(validSizes)}`
      );
    }

    if (!isNaN(duration)) {
      if (duration < VIDEO_MIN_DURATION) {
        errors.push(`Duration: ${duration.toFixed(1)}s — minimum ${VIDEO_MIN_DURATION}s`);
      } else if (duration > VIDEO_MAX_DURATION) {
        errors.push(`Duration: ${duration.toFixed(1)}s — maximum ${VIDEO_MAX_DURATION}s`);
      }
    }
  } catch {
    errors.push("Cannot read video file — file may be corrupted");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings: errors.length === 0 ? BASIC_MODE_WARNINGS : [],
  };
}

// ── Video validation — deep (ffmpeg.wasm) ────────────────────────────────────

// Mutex: serialize all ffmpeg.wasm calls — singleton FS is not thread-safe
let ffmpegQueue: Promise<void> = Promise.resolve();

async function validateVideoDeep(file: File, device: DeviceType): Promise<ValidationResult> {
  // Start with basic checks
  const basic = await validateVideoBasic(file, device);
  if (!basic.ok && basic.errors.some((e) => e.startsWith("Cannot read"))) {
    return basic; // Can't even read — skip deep
  }

  const errors = [...basic.errors];
  const warnings: string[] = [];

  // Acquire queue slot — wait for any prior validateVideoDeep call to finish
  let releaseQueue!: () => void;
  const myTurn = ffmpegQueue;
  ffmpegQueue = new Promise<void>((resolve) => { releaseQueue = resolve; });
  await myTurn;

  try {
    const { fetchFile } = await import("@ffmpeg/util");
    const { getFFmpeg } = await import("@/lib/ffmpeg-loader");
    const ffmpeg = await getFFmpeg();

    const inputName = `input_${Date.now()}_${Math.random().toString(36).slice(2)}.${file.name.split(".").pop()}`;
    await ffmpeg.writeFile(inputName, await fetchFile(file));

    // Run ffprobe-style via ffmpeg -i (reads streams info, exits with error but we parse stderr)
    let probeOutput = "";
    const logHandler = ({ message }: { message: string }) => { probeOutput += message + "\n"; };
    ffmpeg.on("log", logHandler);

    try {
      await ffmpeg.exec(["-i", inputName, "-hide_banner"]);
    } catch {
      // ffmpeg exits with error when no output specified — that's expected, we just need the log
    }

    ffmpeg.off("log", logHandler);
    await ffmpeg.deleteFile(inputName);

    // Parse FPS: e.g. "25 fps" or "29.97 fps"
    const fpsMatch = probeOutput.match(/(\d+(?:\.\d+)?)\s+fps/);
    if (fpsMatch) {
      const fps = parseFloat(fpsMatch[1]);
      if (fps > VIDEO_MAX_FPS) {
        errors.push(`FPS: ${fps}fps — max ${VIDEO_MAX_FPS}fps`);
      }
    }

    // Parse bitrate: e.g. "bitrate: 11200 kb/s"
    const bitrateMatch = probeOutput.match(/bitrate:\s*(\d+)\s*kb\/s/);
    if (bitrateMatch) {
      const kbps = parseInt(bitrateMatch[1]);
      if (kbps < VIDEO_BITRATE_MIN_KBPS || kbps > VIDEO_BITRATE_MAX_KBPS) {
        errors.push(
          `Bitrate: ${(kbps / 1000).toFixed(1)} Mbps — must be ${VIDEO_BITRATE_MIN_KBPS / 1000}–${VIDEO_BITRATE_MAX_KBPS / 1000} Mbps`
        );
      }
    }

    // Parse audio codec
    const audioMatch = probeOutput.match(/Audio:\s*(\w+)/);
    if (audioMatch) {
      const codec = audioMatch[1].toLowerCase();
      if (codec !== "aac") {
        errors.push(`Audio codec: "${codec}" — must be AAC`);
      }
    }

    // Parse sample rate
    const sampleRateMatch = probeOutput.match(/(\d+)\s*Hz/);
    if (sampleRateMatch) {
      const hz = parseInt(sampleRateMatch[1]);
      if (hz !== 44100 && hz !== 48000) {
        errors.push(`Audio sample rate: ${hz}Hz — must be 44100Hz or 48000Hz`);
      }
    }

    // Parse channels: stereo check
    const channelMatch = probeOutput.match(/Audio:.*?(stereo|mono|5\.1|7\.1)/i);
    if (channelMatch) {
      const ch = channelMatch[1].toLowerCase();
      if (ch !== "stereo") {
        errors.push(`Audio: ${ch} — stereo required`);
      }
    }

    // Stereo track config: warning only (cannot verify precisely)
    if (!errors.some((e) => e.startsWith("Audio"))) {
      warnings.push("Stereo config: verify 1 track 2-ch (L+R) or 2 tracks 1-ch (L, R)");
    }

  } catch (err) {
    // ffmpeg.wasm load failed — fall back to basic mode warnings
    warnings.push(...BASIC_MODE_WARNINGS);
    console.warn("[asset-validator] ffmpeg.wasm failed, falling back to basic:", err);
  } finally {
    releaseQueue();
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function validateVideo(
  file: File,
  device: DeviceType
): Promise<ValidationResult> {
  if (isDeepMode()) {
    return validateVideoDeep(file, device);
  }
  return validateVideoBasic(file, device);
}

/**
 * Validate screenshot count against limits.
 * Call after all per-file validations, with the count of files that passed.
 */
export function validateScreenshotCount(
  device: DeviceType,
  existingCount: number,
  newValidCount: number
): ValidationResult {
  const total = existingCount + newValidCount;
  // Intentionally ignoring SCREENSHOT_LIMITS[device].min here — the minimum is
  // a submit-time invariant, not a drop-time one. Only max matters on drop.
  const { max } = SCREENSHOT_LIMITS[device];
  const errors: string[] = [];

  if (total > max) {
    errors.push(`Too many screenshots: ${total} total — max ${max}`);
  }

  return { ok: errors.length === 0, errors, warnings: [] };
}

/**
 * Validate video count.
 */
export function validateVideoCount(
  existingCount: number,
  newValidCount: number
): ValidationResult {
  const total = existingCount + newValidCount;
  const errors: string[] = [];

  if (total > VIDEO_MAX_COUNT) {
    errors.push(`Too many videos: ${total} total — max ${VIDEO_MAX_COUNT}`);
  }

  return { ok: errors.length === 0, errors, warnings: [] };
}
