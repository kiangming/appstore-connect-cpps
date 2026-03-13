import { NextResponse } from "next/server";
import { submitCpps } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import { log } from "@/lib/logger";

/**
 * POST /api/asc/cpps/submit
 * Body: { appId: string, items: Array<{ cppId: string; versionId: string }> }
 *
 * Submits all CPP versions in a single Apple Review Submission (API v1.7+):
 * 1 reviewSubmissions → N reviewSubmissionItems → PATCH state=SUBMITTED
 */
export async function POST(req: Request) {
  try {
    const { appId, items } = await req.json() as {
      appId: string;
      items: Array<{ cppId: string; versionId: string }>;
    };

    const creds = await getActiveAccount();
    const versionIds = items.map((i) => i.versionId);

    await submitCpps(creds, appId, versionIds);

    await log(
      "cpp-submit",
      `[API] POST /api/asc/cpps/submit success — ${items.length} CPP(s): ${items.map((i) => i.cppId).join(", ")}`
    );
    return new NextResponse(null, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    await log("cpp-submit", `[API] POST /api/asc/cpps/submit error: ${message}`, "ERROR");
    const status = message.includes("403")
      ? 403
      : message.includes("409")
      ? 409
      : message.includes("422")
      ? 422
      : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
