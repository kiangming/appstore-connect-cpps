import { NextResponse } from "next/server";
import { prepareCppSubmission } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import { log } from "@/lib/logger";

/**
 * POST /api/asc/cpps/submit/prepare
 * Body: { appId: string, items: Array<{ cppId: string; cppName: string; versionId: string }> }
 *
 * Creates reviewSubmission container, then sequentially adds each item
 * (200ms gap, up to 3 attempts each). Returns per-item results so the
 * client can decide to confirm or rollback.
 */
export async function POST(req: Request) {
  try {
    const { appId, items } = (await req.json()) as {
      appId: string;
      items: Array<{ cppId: string; cppName: string; versionId: string }>;
    };

    const creds = await getActiveAccount();
    const result = await prepareCppSubmission(creds, appId, items);

    const succeeded = result.items.filter((i) => i.status === "success").length;
    const failed = result.items.filter((i) => i.status === "failed").length;

    await log(
      "cpp-submit",
      `[API] POST /api/asc/cpps/submit/prepare — submissionId=${result.submissionId} succeeded=${succeeded} failed=${failed}`
    );

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    await log("cpp-submit", `[API] POST /api/asc/cpps/submit/prepare error: ${message}`, "ERROR");
    const status = message.includes("403") ? 403 : message.includes("409") ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
