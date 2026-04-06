import { NextResponse } from "next/server";
import { rollbackCppSubmission } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import { log } from "@/lib/logger";

/**
 * DELETE /api/asc/cpps/submit/:submissionId
 *
 * Deletes the reviewSubmission container, rolling back all added items.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: { submissionId: string } }
) {
  try {
    const creds = await getActiveAccount();
    await rollbackCppSubmission(creds, params.submissionId);

    await log(
      "cpp-submit",
      `[API] DELETE /api/asc/cpps/submit/${params.submissionId} success (rollback)`
    );
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    await log(
      "cpp-submit",
      `[API] DELETE /api/asc/cpps/submit/${params.submissionId} error: ${message}`,
      "ERROR"
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
