import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import {
  createAccount,
  listAccounts,
} from "@/lib/google-iap-management/repository/google-accounts";
import { appendAction } from "@/lib/google-iap-management/repository/actions-log";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const accounts = await listAccounts();
    return NextResponse.json({ accounts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { displayName, serviceAccountJson } = (body ?? {}) as Record<
    string,
    unknown
  >;

  if (typeof displayName !== "string" || !displayName.trim()) {
    return NextResponse.json(
      { error: "displayName is required." },
      { status: 400 },
    );
  }
  if (typeof serviceAccountJson !== "string" || !serviceAccountJson.trim()) {
    return NextResponse.json(
      { error: "serviceAccountJson is required (paste the full .json file content)." },
      { status: 400 },
    );
  }

  try {
    const account = await createAccount({
      displayName: displayName.trim(),
      serviceAccountJson,
    });
    await appendAction({
      actionType: "ACCOUNT_CREATE",
      actorEmail: session.user.email ?? null,
      targetId: account.id,
      payload: {
        display_name: account.display_name,
        service_account_email: account.service_account_email,
      },
    });
    return NextResponse.json({ account }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create account";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
