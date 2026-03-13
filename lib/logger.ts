import { promises as fs } from "fs";
import path from "path";

const LOG_DIR = path.join(process.cwd(), "logs");
const ENABLED = process.env.LOG_TO_FILE === "1";

export type LogLevel = "INFO" | "WARN" | "ERROR";

export async function log(
  feature: string,
  message: string,
  level: LogLevel = "INFO"
): Promise<void> {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${message}\n`;

  // Always write to console
  if (level === "ERROR") {
    console.error(`[${feature}] ${message}`);
  } else {
    console.log(`[${feature}] ${message}`);
  }

  if (!ENABLED) return;

  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.appendFile(path.join(LOG_DIR, `${feature}.log`), line, "utf8");
  } catch {
    // Silently ignore — file logging failure must not crash the request
  }
}
