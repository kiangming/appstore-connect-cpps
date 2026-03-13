import { NextResponse } from "next/server";
import { submitCpp } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import { log } from "@/lib/logger";

export async function POST(
  req: Request,
  { params }: { params: { cppId: string } }
) {
  try {
    const { versionId } = await req.json();
    const creds = await getActiveAccount();
    await submitCpp(creds, versionId);
    await log("cpp-submit", `[API] POST /api/asc/cpps/${params.cppId}/submit success`);
    return new NextResponse(null, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    await log("cpp-submit", `[API] POST /api/asc/cpps/${params.cppId}/submit error: ${message}`, "ERROR");
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
