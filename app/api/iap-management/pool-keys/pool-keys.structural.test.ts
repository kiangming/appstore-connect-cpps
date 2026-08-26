/**
 * [POOL-key-management-UI] U1 — the guards that behavioural tests cannot make.
 *
 * Three of these are about what the code must NOT do (log a key, echo a key,
 * store plaintext) and one is about a single missing argument. All four are
 * properties of the source, and a passing behavioural test proves nothing
 * about any of them: a route that logs the private key still returns the
 * right JSON.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname);
const listAdd = readFileSync(join(DIR, "route.ts"), "utf8");
const toggle = readFileSync(join(DIR, "[keyId]", "route.ts"), "utf8");
const test = readFileSync(join(DIR, "[keyId]", "test", "route.ts"), "utf8");
const admin = readFileSync(
  join(DIR, "..", "..", "..", "..", "lib", "iap-management", "key-pool", "admin.ts"),
  "utf8",
);

/** Source with comments and string bodies blanked — P28. */
function codeOnly(text: string): string {
  const out = text.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === "//") {
      const end = text.indexOf("\n", i);
      blank(i, end < 0 ? text.length : end);
      i = end < 0 ? text.length : end;
    } else if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      blank(i, end < 0 ? text.length : end + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (text[i] === '"' || text[i] === "'" || text[i] === "`") {
      const q = text[i];
      let j = i + 1;
      while (j < text.length && text[j] !== q) {
        if (text[j] === "\\") j++;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else i++;
  }
  return out.join("");
}

/**
 * Comments blanked, STRINGS KEPT.
 *
 * ⚠ THIS EXISTS BECAUSE `codeOnly` MADE THE LEAK GUARD BLIND, and the
 * mutation proved it: logging `` `… privateKey=${privateKey}` `` passed all
 * 38 tests. Template-literal interpolation is THE realistic way a secret
 * reaches a log line, and it lives inside a string — precisely what
 * `codeOnly` erases. Stripping comments is still necessary (this file's own
 * prose says "private key" repeatedly), but stripping strings here would
 * remove the evidence instead of the noise. Right tool per question: use
 * `codeOnly` to ask "does the code CALL x", `commentsOnly` to ask "does any
 * string mention a secret".
 */
function commentsOnly(text: string): string {
  const out = text.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === "//") {
      const end = text.indexOf("\n", i);
      blank(i, end < 0 ? text.length : end);
      i = end < 0 ? text.length : end;
    } else if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      blank(i, end < 0 ? text.length : end + 2);
      i = end < 0 ? text.length : end + 2;
    } else i++;
  }
  return out.join("");
}

/** Every `log(...)` / `console.x(...)` call, sliced to its closing paren. */
function logCalls(src: string): string[] {
  const code = commentsOnly(src);
  const out: string[] = [];
  const re = /\b(?:await\s+)?(?:log|console\.\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    let depth = 1;
    let j = re.lastIndex;
    while (j < code.length && depth > 0) {
      if (code[j] === "(") depth++;
      else if (code[j] === ")") depth--;
      j++;
    }
    out.push(code.slice(m.index, j));
  }
  return out;
}

const ALL = [
  ["list+add", listAdd],
  ["toggle", toggle],
  ["test", test],
] as const;

// ─── (a) never log or echo the private key ──────────────────────────────────

describe("⚠ (a) the private key is never logged and never echoed", () => {
  it("no route logs the request body", () => {
    // The ordinary debugging reflex — dump the parsed body on a 400 — would
    // write an Apple private key into Railway in plaintext, permanently.
    for (const [name, src] of ALL) {
      for (const call of logCalls(src)) {
        expect(call, `${name}: ${call.slice(0, 90)}`).not.toMatch(/\bbody\b/);
      }
      expect(codeOnly(src), name).not.toMatch(/JSON\.stringify\(\s*body\s*\)/);
    }
  });

  it("⚠ no route logs the private key, including via template interpolation", () => {
    // ⚠ Scanned with strings KEPT. `${privateKey}` inside a template literal
    // is the realistic leak, and it is invisible to a comment-and-string
    // stripper — the mutation that logs it passed all 38 tests until this
    // assertion learned to look inside the string.
    for (const [name, src] of ALL) {
      for (const call of logCalls(src)) {
        expect(call, `${name}: ${call.slice(0, 90)}`).not.toMatch(/privateKey/);
        expect(call, `${name}: ${call.slice(0, 90)}`).not.toMatch(/private_key/);
      }
    }
  });

  it("⚠ and the guard can actually see inside a template literal", () => {
    // Guards the guard: if `logCalls` ever starts blanking strings again,
    // this fails rather than every leak assertion silently passing.
    const sample = 'await log(TAG, `added key=${keyId} privateKey=${privateKey}`);';
    expect(logCalls(sample).join("")).toContain("privateKey");
  });

  it("⚠ no route puts key material in a JSON response", () => {
    for (const [name, src] of ALL) {
      const code = codeOnly(src);
      const responses = code.match(/NextResponse\.json\([\s\S]{0,400}?\)/g) ?? [];
      for (const r of responses) {
        expect(r, `${name}: ${r.slice(0, 80)}`).not.toMatch(/privateKey/);
        expect(r, `${name}: ${r.slice(0, 80)}`).not.toMatch(/privateKeyEnc/);
        expect(r, `${name}: ${r.slice(0, 80)}`).not.toMatch(/private_key_enc/);
      }
    }
  });

  it("⚠ the admin query layer never SELECTs the ciphertext for list views", () => {
    const code = codeOnly(admin);
    // `findPoolKeyById` legitimately reads it (the Test route must decrypt);
    // the LIST paths must not, and `select("*")` would pull it in silently.
    expect(code).not.toMatch(/select\(\s*"\s*\*\s*"\s*\)/);
    const listFn = code.slice(code.indexOf("listAllPoolKeys"), code.indexOf("findPoolKeyById"));
    expect(listFn).not.toContain("private_key_enc");
  });
});

// ─── (b) encryption is not optional ─────────────────────────────────────────

describe("⚠ (b) a key is encrypted before it is stored", () => {
  it("the add route calls encryptPrivateKey", () => {
    expect(codeOnly(listAdd)).toMatch(/encryptPrivateKey\(/);
  });

  it("⚠ the insert helper takes CIPHERTEXT — plaintext cannot reach the table", () => {
    // The parameter is named `privateKeyEnc` and the insert writes exactly
    // it. If a future edit passed the raw key, this reads it at the call
    // site rather than trusting the name.
    const code = codeOnly(admin);
    const fn = code.slice(code.indexOf("export async function insertPoolKey"));
    expect(fn).toMatch(/private_key_enc:\s*input\.privateKeyEnc/);
    expect(fn).not.toMatch(/private_key_enc:\s*input\.privateKey\b/);
  });

  it("⚠ the add route does not write the table directly, bypassing that helper", () => {
    expect(codeOnly(listAdd)).not.toContain("asc_account_keys");
  });
});

// ─── (c) Test key tests THE key, not a rotated one ──────────────────────────

describe("⚠ (c) Test key signs with the specified key, never a rotated one", () => {
  it("⚠ does NOT pass a keyPool to appleFetch", () => {
    // `appleFetch` selects a key only when handed a pool; with none it signs
    // with exactly the credentials given. Passing one here would verify
    // whatever rotation picked — on a two-key account, the wrong key half
    // the time — and a green tick for a key that was never tested is worse
    // than no button at all.
    const code = codeOnly(test);
    expect(code).not.toMatch(/keyPool/);
    expect(code).not.toMatch(/iapKeyPool/);
  });

  it("does not go through iapFetch, which injects the pool", () => {
    expect(codeOnly(test)).not.toMatch(/\biapFetch\b/);
  });

  it("builds credentials from THIS row's key id", () => {
    const code = codeOnly(test);
    expect(code).toMatch(/poolKeyToCredentials\(/);
    expect(code).toMatch(/keyId:\s*row\.keyId/);
  });

  it("hits the endpoint that actually returns the budget header", () => {
    // KB §4.9: the two IAP endpoints omit `x-rate-limit` entirely, so they
    // could confirm the key works but never show rem/lim.
    //
    // ⚠ Asserted against RAW source, not `codeOnly`: the endpoint is a string
    // literal and `codeOnly` blanks string bodies on purpose. Using the
    // stripped copy here would have made this pass vacuously forever — the
    // P28 shape, one file later.
    expect(test).toContain("/v1/territories?limit=1");
  });
});

// ─── (d) admin gate on every route ──────────────────────────────────────────

describe("⚠ (d) every route is admin-gated", () => {
  it("all three call requireIapAdmin", () => {
    for (const [name, src] of ALL) {
      expect(codeOnly(src), name).toMatch(/requireIapAdmin\(\)/);
    }
  });

  it("⚠ every exported handler gates BEFORE doing work", () => {
    for (const [name, src] of ALL) {
      const code = codeOnly(src);
      const handlers = [...code.matchAll(/export async function (GET|POST|PATCH|DELETE)\b/g)];
      expect(handlers.length, `${name} has handlers`).toBeGreaterThan(0);
      for (const h of handlers) {
        const body = code.slice(h.index ?? 0);
        const gate = body.indexOf("requireIapAdmin");
        const work = body.search(/await (findPoolKeyById|listAllPoolKeys|insertPoolKey|setPoolKeyEnabled|appleFetch|request\.json)/);
        expect(gate, `${name} ${h[1]} gates`).toBeGreaterThan(-1);
        if (work > -1) expect(gate, `${name} ${h[1]} gates first`).toBeLessThan(work);
      }
    }
  });

  it("maps forbidden to 403 and unauthorized to 401", () => {
    for (const [name, src] of ALL) {
      const code = codeOnly(src);
      expect(code, name).toMatch(/IapForbiddenError/);
      expect(code, name).toMatch(/status:\s*403/);
      expect(code, name).toMatch(/status:\s*401/);
    }
  });
});

// ─── (e) accounts come from the database ────────────────────────────────────

describe("⚠ (e) the account list is read, never hardcoded", () => {
  it("the dropdown source reads asc_accounts through the repository", () => {
    const code = codeOnly(admin);
    expect(code).toMatch(/findAllAccounts\(\)/);
  });

  it("⚠ and it drops the private key field by field, not by spread-and-delete", () => {
    // A spread would carry `privateKey` in by default and rely on someone
    // remembering to remove it; an explicit mapping cannot leak a NEW secret
    // field that lands on AscAccount later.
    const code = codeOnly(admin);
    const fn = code.slice(
      code.indexOf("export async function listAccountOptions"),
      code.indexOf("export async function listAllPoolKeys"),
    );
    expect(fn).toMatch(/id:\s*a\.id/);
    expect(fn).toMatch(/name:\s*a\.name/);
    expect(fn).toMatch(/issuerId:\s*a\.issuerId/);
    expect(fn).not.toMatch(/\.\.\.a\b/);
    expect(fn).not.toContain("privateKey");
  });

  it("the add route verifies the account exists rather than trusting the client", () => {
    // account_id is a soft TEXT ref with no FK, so a bad id inserts happily
    // and the key becomes invisible to every account, forever.
    expect(codeOnly(listAdd)).toMatch(/findAccountById\(/);
  });
});
