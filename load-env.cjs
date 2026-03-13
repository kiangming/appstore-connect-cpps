/**
 * load-env.cjs
 *
 * Parses .env.local and sets process.env before starting the Next.js server.
 * Handles:
 *   - Single-line unquoted values
 *   - Single-quoted values (no escape processing)
 *   - Double-quoted values with \n / \" escapes, spanning multiple lines
 *   - JSON values starting with [ or { spanning multiple lines (bracket-balanced)
 *   - Private keys with literal newlines inside JSON
 *   - Comments (#) and blank lines
 */

const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, ".env.local");

if (!fs.existsSync(envPath)) {
  console.error("Missing .env.local");
  process.exit(1);
}

const content = fs.readFileSync(envPath, "utf8");
const lines = content.split("\n");

/**
 * Check if a JSON string fragment is "complete" by counting brackets
 * while respecting quoted strings and escape sequences.
 */
function isJsonComplete(str) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (escaped) { escaped = false; continue; }
    if (c === "\\") { escaped = true; continue; }
    if (inString) {
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return true;
    }
  }
  return false;
}

let i = 0;
while (i < lines.length) {
  const line = lines[i];
  i++;

  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;

  const eqIdx = line.indexOf("=");
  if (eqIdx === -1) continue;

  const key = line.slice(0, eqIdx).trim();
  if (!key) continue;

  let rawValue = line.slice(eqIdx + 1);
  let value;

  if (rawValue.startsWith("'")) {
    // Single-quoted: read until closing ' (no escapes, may span lines)
    let acc = rawValue.slice(1);
    while (true) {
      const closeIdx = acc.indexOf("'");
      if (closeIdx !== -1) {
        value = acc.slice(0, closeIdx);
        break;
      }
      if (i >= lines.length) { value = acc; break; }
      acc += "\n" + lines[i++];
    }

  } else if (rawValue.startsWith('"')) {
    // Double-quoted: process \n \\ \" escapes, may span lines
    let acc = rawValue.slice(1);
    let result = "";
    let closed = false;
    outer: while (true) {
      for (let j = 0; j < acc.length; j++) {
        if (acc[j] === "\\" && j + 1 < acc.length) {
          const next = acc[j + 1];
          result += next === "n" ? "\n" : next === "t" ? "\t" : next;
          j++;
        } else if (acc[j] === '"') {
          closed = true;
          break outer;
        } else {
          result += acc[j];
        }
      }
      if (i >= lines.length) break;
      result += "\n";
      acc = lines[i++];
    }
    value = result;

  } else if (rawValue.trimStart().startsWith("[") || rawValue.trimStart().startsWith("{")) {
    // JSON value: read until brackets are balanced (handles multi-line private keys)
    let acc = rawValue;
    while (!isJsonComplete(acc)) {
      if (i >= lines.length) break;
      acc += "\n" + lines[i++];
    }
    // Strip trailing whitespace/comment after closing bracket
    const closeMatch = acc.match(/^([\s\S]*?[}\]])\s*(?:#.*)?$/);
    value = closeMatch ? closeMatch[1] : acc.trim();

  } else {
    // Unquoted single-line: strip trailing inline comment
    value = rawValue.replace(/\s+#.*$/, "").trim();
  }

  if (key && value !== undefined) {
    process.env[key] = value;
  }
}

// Start the Next.js standalone server
require("./server.js");
