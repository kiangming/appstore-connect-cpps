/**
 * D9 [arc-google-missing-purchase-options] — the Manager declares (or confirms)
 * an app's currency or language. The ONLY route that writes those columns.
 *
 * POST { field: "currency" | "language", value: string,
 *        appId: string, expected: { value, source } }
 *   → validates the value (a currency Google Play bills in / one of the locale
 *     codes this tool supports), writes value + source='declared' on THIS app
 *     row, audits APP_DEFAULTS_DECLARE with the previous value and provenance.
 * "Confirm" in the UI is the same call with the current value — one click.
 *
 * `appId` + `expected` say WHICH row and WHICH value the Manager was looking
 * at. The app is resolved from the active-account cookie; a tab whose account
 * was switched elsewhere would otherwise declare onto another account's row
 * (P35), and a stale "Confirm USD" would replace a newer declaration. Either
 * mismatch ⇒ 409, nothing written. The write itself is compare-and-set too
 * (declareAppDefault), so a declaration racing in between is not lost.
 *
 * Admin only: the value changes how every bulk import of this app is priced.
 * ⚠ The role check runs BEFORE any lookup (KB §25.1, P34) — a non-admin gets
 *   403 whether or not the app exists, so the route cannot be used as an oracle.
 */
import { NextResponse } from "next/server";

import {
  GoogleIapForbiddenError,
  GoogleIapUnauthorizedError,
  requireGoogleIapAdmin,
} from "@/lib/google-iap-management/auth";
import { listAccounts } from "@/lib/google-iap-management/repository/google-accounts";
import {
  AppDefaultChangedError,
  declareAppDefault,
  getAppByPackage,
  getAppImportReadiness,
} from "@/lib/google-iap-management/repository/apps";
import { appendAction } from "@/lib/google-iap-management/repository/actions-log";
import {
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";
import {
  APP_DEFAULT_DECLARED,
  APP_DEFAULT_FIELDS,
  APP_DEFAULT_GUESSED,
  validateAppDefault,
  type AppDefaultField,
  type AppDefaultValue,
} from "@/lib/google-iap-management/app-defaults";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: { packageName: string } },
) {
  let session;
  try {
    session = await requireGoogleIapAdmin();
  } catch (err) {
    if (err instanceof GoogleIapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    if (err instanceof GoogleIapForbiddenError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  let body: { field?: unknown; value?: unknown; appId?: unknown; expected?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const field = body.field;
  if (typeof field !== "string" || !(APP_DEFAULT_FIELDS as readonly string[]).includes(field)) {
    return NextResponse.json(
      { error: `field must be one of ${APP_DEFAULT_FIELDS.join(", ")}.` },
      { status: 400 },
    );
  }
  const validated = validateAppDefault(field as AppDefaultField, body.value);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const expected = parseExpected(body.expected);
  if (typeof body.appId !== "string" || body.appId === "" || !expected) {
    return NextResponse.json(
      { error: "appId and expected { value, source } are required — reload the app page." },
      { status: 400 },
    );
  }

  // D2 — an accounts READ error is not "no accounts configured".
  let accounts: Awaited<ReturnType<typeof listAccounts>>;
  try {
    accounts = await listAccounts();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Could not read Google Console accounts (${detail}). Nothing was written.` },
      { status: 503 },
    );
  }
  const accountId = resolveActiveAccountId(accounts, readActiveAccountId());
  if (!accountId) {
    return NextResponse.json(
      { error: "No Google Console accounts configured. Add one in Settings → Google Console Accounts first." },
      { status: 400 },
    );
  }
  const packageName = decodeURIComponent(params.packageName);
  const app = await getAppByPackage(accountId, packageName);
  if (!app) {
    return NextResponse.json(
      { error: `App "${packageName}" is not cached. Refresh the apps list first.` },
      { status: 404 },
    );
  }

  if (app.id !== body.appId) {
    return NextResponse.json(
      {
        error:
          "The active Google Console account changed since this page loaded — this is not the " +
          "app you were looking at. Reload the page. Nothing was written.",
        code: "APP_CHANGED",
      },
      { status: 409 },
    );
  }

  let previous: AppDefaultValue;
  try {
    const before = await getAppImportReadiness(app.id);
    previous = before.defaults[field as AppDefaultField];
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read the app's current value.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
  if (previous.value !== expected.value || previous.source !== expected.source) {
    return NextResponse.json(staleBody(field, previous), { status: 409 });
  }

  try {
    await declareAppDefault(app.id, field as AppDefaultField, validated.value, expected);
  } catch (err) {
    if (err instanceof AppDefaultChangedError) {
      return NextResponse.json(staleBody(field, null), { status: 409 });
    }
    const message = err instanceof Error ? err.message : "Failed to declare the app default.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // The value IS declared from here on. A failure below must not report the
  // declaration as failed (P5) — the Manager would retry or file a bug for an
  // action that worked.
  try {
    await appendAction({
      actionType: "APP_DEFAULTS_DECLARE",
      actorEmail: session.user.email ?? null,
      targetId: app.id,
      payload: {
        package_name: packageName,
        field,
        value: validated.value,
        previous_value: previous.value,
        previous_source: previous.source,
        // A confirmation keeps the value; a declaration changes it.
        kind: previous.value === validated.value ? "confirm" : "declare",
      },
    });
  } catch (err) {
    // appendAction logs and swallows its own insert errors; this only guards
    // a throw. The audit gap is logged, the declaration stands.
    console.error(
      `[google-iap:defaults] audit failed after declare pkg=${packageName} field=${field}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  try {
    const after = await getAppImportReadiness(app.id);
    return NextResponse.json({ ok: true, defaults: after.defaults });
  } catch (err) {
    return NextResponse.json({
      ok: true,
      defaults: null,
      reread_error: err instanceof Error ? err.message : String(err),
    });
  }
}

function parseExpected(raw: unknown): AppDefaultValue | null {
  if (!raw || typeof raw !== "object") return null;
  const { value, source } = raw as { value?: unknown; source?: unknown };
  if (value !== null && typeof value !== "string") return null;
  if (source !== null && source !== APP_DEFAULT_DECLARED && source !== APP_DEFAULT_GUESSED) return null;
  return { value, source };
}

function staleBody(field: string, now: AppDefaultValue | null) {
  const current = now
    ? ` It is now ${now.value ?? "not set"}${now.source ? ` (${now.source})` : ""}.`
    : "";
  return {
    error: `This app's ${field} changed since the page loaded.${current} Reload the page and try again. Nothing was written.`,
    code: "DEFAULT_CHANGED",
  };
}
