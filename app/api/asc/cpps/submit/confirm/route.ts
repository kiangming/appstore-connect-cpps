import { NextResponse } from "next/server";
import { confirmCppSubmission } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import { log } from "@/lib/logger";

/**
 * POST /api/asc/cpps/submit/confirm
 * Body: { submissionId: string }
 *
 * PATCHes the reviewSubmission with submitted:true to send it to Apple Review.
 */
export async function POST(req: Request) {
  try {
    const { submissionId } = (await req.json()) as { submissionId: string };

    const creds = await getActiveAccount();
    await confirmCppSubmission(creds, submissionId);

    await log(
      "cpp-submit",
      `[API] POST /api/asc/cpps/submit/confirm success — submissionId=${submissionId}`
    );
    return new NextResponse(null, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    await log("cpp-submit", `[API] POST /api/asc/cpps/submit/confirm error: ${message}`, "ERROR");
    const status = message.includes("403") ? 403 : message.includes("409") ? 409 : message.includes("422") ? 422 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
