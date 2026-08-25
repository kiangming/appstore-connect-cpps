/**
 * C3 C-3 [Q-C3.conflict-read-B] — the read cache must be written, and written
 * ONLY where a write to Apple actually happened.
 *
 * ⚠ WHY STRUCTURAL. `execute/route.ts` has no orchestration harness; the same
 * reasoning `batch-close-guard` and `locale-loop-break` record. The claim here
 * is about one statement inside `persistResult` and the guard that surrounds
 * it, and source is the only place that claim is visible.
 *
 * ⚠ THE BOUNDARY IS THE INTERESTING HALF. Writing the cache is easy to notice
 * if it breaks — the conflict row goes quiet. Writing it for a row that never
 * reached Apple is silent and worse: the NEXT batch's conflict screen would
 * describe a product this batch never touched, which is precisely the kind of
 * confident-and-wrong the screen was added to prevent.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(
    __dirname, "..", "..", "..",
    "app", "api", "iap-management", "apps", "[appId]",
    "bulk-import", "execute", "route.ts",
  ),
  "utf8",
);

/** `persistResult`'s body, from its signature to the end of the file. */
function persistResultBody(): string {
  const at = src.indexOf("async function persistResult(");
  expect(at).toBeGreaterThan(-1);
  return src.slice(at);
}

/** The `iaps` upsert statement inside persistResult. */
function iapsUpsert(): string {
  const body = persistResultBody();
  const at = body.indexOf('.from("iaps")');
  expect(at).toBeGreaterThan(-1);
  return body.slice(at, body.indexOf("} catch", at));
}

describe("the last-import read cache is written on the existing upsert", () => {
  it("⚠ the upsert writes both cache columns", () => {
    const stmt = iapsUpsert();
    expect(stmt).toContain("last_import_status: result.status");
    expect(stmt).toContain("last_import_summary: result.summary");
  });

  it("⚠ it is the SAME statement that already mirrors the row — not a new write", () => {
    // A second statement is a second thing that can fail, against a path
    // whose failure is only logged. There must be exactly one `iaps` write
    // in persistResult.
    const body = persistResultBody();
    const count = body.split('.from("iaps")').length - 1;
    expect(count).toBe(1);
  });

  it("⚠ the status written is the ROW'S OWN, never a literal", () => {
    // `last_import_status: "SUCCESS"` would make every cached verdict a lie
    // for exactly the rows the conflict screen exists to flag.
    const stmt = iapsUpsert();
    expect(stmt).not.toMatch(/last_import_status:\s*"/);
  });
});

describe("⚠ rows that never reached Apple are NOT cached", () => {
  it("the upsert stays behind the SUCCESS-or-PARTIAL guard", () => {
    // ERROR / SKIPPED / NOT_ATTEMPTED have no verdict to cache: nothing of
    // theirs reached Apple. The guard that already protected the mirror row
    // (so it could not invent an iaps row) protects the cache for the same
    // reason — which is why the cache lives inside it rather than beside it.
    const body = persistResultBody();
    const guard = body.indexOf('result.status === "SUCCESS" || result.status === "PARTIAL"');
    const upsert = body.indexOf('.from("iaps")');
    const cache = body.indexOf("last_import_status:");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(upsert);
    expect(upsert).toBeLessThan(cache);
  });

  it("⚠ and that guard also requires an apple_iap_id", () => {
    // Belt and braces: a row claiming SUCCESS with no Apple id never happened.
    const body = persistResultBody();
    const guard = body.slice(
      body.indexOf('result.status === "SUCCESS" || result.status === "PARTIAL"'),
      body.indexOf('.from("iaps")'),
    );
    expect(guard).toContain("result.apple_iap_id");
  });

  it("no OTHER route statement writes the cache columns", () => {
    // If a second writer appears it must be considered deliberately: two
    // writers with different guards is how the boundary above erodes.
    expect(src.split("last_import_status:").length - 1).toBe(1);
    expect(src.split("last_import_summary:").length - 1).toBe(1);
  });
});
