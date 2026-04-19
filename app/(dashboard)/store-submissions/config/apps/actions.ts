'use server';

import { revalidatePath } from 'next/cache';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import {
  StoreForbiddenError,
  StoreUnauthorizedError,
  requireStoreRole,
  type StoreUser,
} from '@/lib/store-submissions/auth';
import { storeDb } from '@/lib/store-submissions/db';
import {
  deriveAliasChangesOnRename,
  generateSlugFromName,
  InvalidSlugError,
  SLUG_MAX_LENGTH,
  type AliasChange,
  type ExistingAlias,
} from '@/lib/store-submissions/apps/alias-logic';
import { parseAppRegistryCsv } from '@/lib/store-submissions/csv/parser';
import {
  countOpenTicketsForApp,
  listAliasesForApp,
} from '@/lib/store-submissions/queries/apps';
import {
  addAliasInputSchema,
  createAppActionInputSchema,
  deleteAppInputSchema,
  importCsvInputSchema,
  removeAliasInputSchema,
  removePlatformBindingInputSchema,
  renameAppInputSchema,
  setPlatformBindingInputSchema,
  updateAppSchema,
  type CreateAppActionInput,
  type PlatformKey,
} from '@/lib/store-submissions/schemas/app';

export type ActionError = {
  code:
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'VALIDATION'
    | 'NOT_FOUND'
    | 'SLUG_TAKEN'
    | 'ALIAS_DUPLICATE'
    | 'UNKNOWN_PLATFORM'
    | 'APP_HAS_TICKETS'
    | 'CSV_FATAL'
    | 'DB_ERROR';
  message: string;
  details?: unknown;
};

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: ActionError };

const APPS_PATH = '/store-submissions/config/apps';

// -- Guards ----------------------------------------------------------------

async function guardManager(): Promise<{ user: StoreUser } | { error: ActionError }> {
  const session = await getServerSession(authOptions);
  try {
    const user = await requireStoreRole(session?.user?.email, 'MANAGER');
    return { user };
  } catch (err) {
    if (err instanceof StoreUnauthorizedError) {
      return { error: { code: 'UNAUTHORIZED', message: err.message } };
    }
    if (err instanceof StoreForbiddenError) {
      return { error: { code: 'FORBIDDEN', message: err.message } };
    }
    throw err;
  }
}

function firstValidationMessage(issues: readonly { message: string }[]): string {
  return issues[0]?.message ?? 'Invalid input';
}

/**
 * PostgREST / Postgres error → ActionError mapping for the App Registry
 * RPCs. See supabase/migrations/*_store_mgmt_app_rpcs.sql for the raised
 * sqlerrm prefixes.
 */
function mapRpcError(message: string | null | undefined): ActionError | null {
  if (!message) return null;
  if (message.includes('SLUG_TAKEN')) {
    return { code: 'SLUG_TAKEN', message: 'An app with this slug already exists' };
  }
  if (message.includes('UNKNOWN_PLATFORM')) {
    return { code: 'UNKNOWN_PLATFORM', message };
  }
  if (message.includes('NOT_FOUND')) {
    return { code: 'NOT_FOUND', message: 'App not found' };
  }
  if (message.includes('ALIAS_MISSING')) {
    return {
      code: 'NOT_FOUND',
      message: 'Alias no longer exists — reload the page and try again',
    };
  }
  if (message.includes('INVALID_ARG')) {
    return { code: 'VALIDATION', message };
  }
  return null;
}

// -- Slug collision resolution --------------------------------------------

/**
 * Resolve a slug candidate against existing rows. If the base slug is taken,
 * try `-2`, `-3`, … up to 99. The loop is a TOCTOU check used only to pick a
 * reasonable candidate; the RPC still relies on the UNIQUE constraint to
 * serialize concurrent writes, so a 23505 from the final INSERT is retried
 * at the call site.
 */
async function suggestAvailableSlug(base: string): Promise<string> {
  const db = storeDb();
  const { data, error } = await db
    .from('apps')
    .select('slug')
    .or(`slug.eq.${base},slug.like.${base}-%`);

  if (error) {
    console.error('[store-apps] slug probe failed:', error);
    throw new Error('Failed to check slug availability');
  }

  const taken = new Set((data ?? []).map((r) => (r as { slug: string }).slug));
  if (!taken.has(base)) return base;

  for (let i = 2; i <= 99; i++) {
    const suffix = `-${i}`;
    const candidate = `${base.slice(0, SLUG_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Could not allocate a slug for "${base}" after 99 attempts`);
}

async function platformIdForKey(key: PlatformKey): Promise<string | null> {
  const { data, error } = await storeDb()
    .from('platforms')
    .select('id')
    .eq('key', key)
    .maybeSingle();
  if (error) {
    console.error('[store-apps] platformIdForKey failed:', error);
    throw new Error('Failed to resolve platform');
  }
  return data ? (data as { id: string }).id : null;
}

// -- Create ----------------------------------------------------------------

export async function createAppAction(
  input: unknown,
): Promise<ActionResult<{ id: string; slug: string }>> {
  const guard = await guardManager();
  if ('error' in guard) return { ok: false, error: guard.error };

  const parsed = createAppActionInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: firstValidationMessage(parsed.error.issues),
      },
    };
  }
  const data = parsed.data satisfies CreateAppActionInput;

  let baseSlug: string;
  try {
    baseSlug = data.slug ?? generateSlugFromName(data.name);
  } catch (err) {
    if (err instanceof InvalidSlugError) {
      return {
        ok: false,
        error: { code: 'VALIDATION', message: err.message },
      };
    }
    throw err;
  }

  // Pick an available slug, then let the RPC's UNIQUE constraint serialize
  // any TOCTOU race. A 23505 on the final INSERT is retried with the next
  // suffix up to MAX_RETRIES times.
  const MAX_RETRIES = 3;
  let lastSuggestion = baseSlug;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const slug = await suggestAvailableSlug(baseSlug);
    lastSuggestion = slug;

    const { data: rpcData, error } = await storeDb().rpc('create_app_tx', {
      p_slug: slug,
      p_name: data.name,
      p_display_name: data.display_name ?? null,
      p_team_owner_id: data.team_owner_id ?? null,
      p_active: data.active,
      p_created_by: guard.user.id,
      p_platform_bindings: (data.platform_bindings ?? []).map((b) => ({
        platform_key: b.platform,
        platform_ref: b.platform_ref ?? null,
        console_url: b.console_url ?? null,
      })),
    });

    if (!error) {
      revalidatePath(APPS_PATH);
      return { ok: true, data: { id: rpcData as string, slug } };
    }

    const mapped = mapRpcError(error.message);
    if (mapped?.code === 'SLUG_TAKEN') {
      // Another concurrent creation claimed our candidate; retry.
      continue;
    }
    if (mapped) return { ok: false, error: mapped };

    console.error('[store-apps] createAppAction:', error);
    return {
      ok: false,
      error: { code: 'DB_ERROR', message: 'Failed to create app' },
    };
  }

  return {
    ok: false,
    error: {
      code: 'SLUG_TAKEN',
      message: `Could not allocate a slug for "${lastSuggestion}" — please retry`,
    },
  };
}

// -- Update (non-name fields only) ----------------------------------------

export async function updateAppAction(input: unknown): Promise<ActionResult> {
  const guard = await guardManager();
  if ('error' in guard) return { ok: false, error: guard.error };

  const parsed = updateAppSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: firstValidationMessage(parsed.error.issues),
      },
    };
  }
  const { id, ...rest } = parsed.data;

  // Renames go through renameAppAction (transactional alias handling). This
  // endpoint intentionally ignores any `name` field — silent skip keeps the
  // single-row UPDATE simple and unambiguous.
  const patch: Record<string, unknown> = {};
  if (rest.display_name !== undefined) patch.display_name = rest.display_name ?? null;
  if (rest.slug !== undefined) patch.slug = rest.slug;
  if (rest.team_owner_id !== undefined) patch.team_owner_id = rest.team_owner_id;
  if (rest.active !== undefined) patch.active = rest.active;

  if (Object.keys(patch).length === 0) {
    return { ok: true, data: undefined };
  }

  const { error } = await storeDb().from('apps').update(patch).eq('id', id);

  if (error) {
    if (error.code === '23505') {
      return {
        ok: false,
        error: { code: 'SLUG_TAKEN', message: 'Slug already in use' },
      };
    }
    console.error('[store-apps] updateAppAction:', error);
    return {
      ok: false,
      error: { code: 'DB_ERROR', message: 'Failed to update app' },
    };
  }

  revalidatePath(APPS_PATH);
  return { ok: true, data: undefined };
}

// -- Rename (transactional) -----------------------------------------------

export async function renameAppAction(
  input: unknown,
): Promise<ActionResult<{ changes: AliasChange[] }>> {
  const guard = await guardManager();
  if ('error' in guard) return { ok: false, error: guard.error };

  const parsed = renameAppInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: firstValidationMessage(parsed.error.issues),
      },
    };
  }

  // Load the current app name + aliases to produce a change plan. This is a
  // TOCTOU read; the RPC re-locks the app row (FOR UPDATE) and re-validates
  // each alias id belongs to the app, so a racing rename can only cause the
  // RPC to raise NOT_FOUND / ALIAS_MISSING — never silently diverge.
  const { data: appRow, error: appErr } = await storeDb()
    .from('apps')
    .select('name')
    .eq('id', parsed.data.id)
    .maybeSingle();

  if (appErr) {
    console.error('[store-apps] renameAppAction load:', appErr);
    return {
      ok: false,
      error: { code: 'DB_ERROR', message: 'Failed to load app' },
    };
  }
  if (!appRow) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'App not found' } };
  }
  const oldName = (appRow as { name: string }).name;
  const aliasRows = await listAliasesForApp(parsed.data.id);
  const existingAliases: ExistingAlias[] = aliasRows.map((a) => ({
    id: a.id,
    alias_text: a.alias_text ?? undefined,
    alias_regex: a.alias_regex ?? undefined,
    source_type: a.source_type,
    previous_name: a.previous_name ?? undefined,
  }));

  const changes = deriveAliasChangesOnRename(oldName, parsed.data.new_name, existingAliases);
  if (changes.length === 0) {
    return { ok: true, data: { changes: [] } };
  }

  const { error } = await storeDb().rpc('rename_app_tx', {
    p_app_id: parsed.data.id,
    p_new_name: parsed.data.new_name,
    p_changes: changes,
  });

  if (error) {
    const mapped = mapRpcError(error.message);
    if (mapped) return { ok: false, error: mapped };
    console.error('[store-apps] renameAppAction rpc:', error);
    return {
      ok: false,
      error: { code: 'DB_ERROR', message: 'Failed to rename app' },
    };
  }

  revalidatePath(APPS_PATH);
  return { ok: true, data: { changes } };
}

// -- Delete / archive ------------------------------------------------------

export async function deleteAppAction(input: unknown): Promise<ActionResult> {
  const guard = await guardManager();
  if ('error' in guard) return { ok: false, error: guard.error };

  const parsed = deleteAppInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: firstValidationMessage(parsed.error.issues),
      },
    };
  }

  const openTickets = await countOpenTicketsForApp(parsed.data.id);

  if (parsed.data.hard) {
    if (openTickets > 0) {
      return {
        ok: false,
        error: {
          code: 'APP_HAS_TICKETS',
          message: `Cannot hard-delete: app has ${openTickets} open ticket(s). Archive instead.`,
        },
      };
    }
    const { error } = await storeDb().from('apps').delete().eq('id', parsed.data.id);
    if (error) {
      console.error('[store-apps] deleteAppAction hard:', error);
      return {
        ok: false,
        error: { code: 'DB_ERROR', message: 'Failed to delete app' },
      };
    }
  } else {
    const { error } = await storeDb()
      .from('apps')
      .update({ active: false })
      .eq('id', parsed.data.id);
    if (error) {
      console.error('[store-apps] deleteAppAction soft:', error);
      return {
        ok: false,
        error: { code: 'DB_ERROR', message: 'Failed to archive app' },
      };
    }
  }

  revalidatePath(APPS_PATH);
  return { ok: true, data: undefined };
}

// -- Aliases ---------------------------------------------------------------

export async function addAliasAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const guard = await guardManager();
  if ('error' in guard) return { ok: false, error: guard.error };

  const parsed = addAliasInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: firstValidationMessage(parsed.error.issues),
      },
    };
  }

  const payload: Record<string, unknown> = {
    app_id: parsed.data.app_id,
    source_type: parsed.data.source_type,
  };
  if (parsed.data.alias_text) payload.alias_text = parsed.data.alias_text;
  if (parsed.data.alias_regex) payload.alias_regex = parsed.data.alias_regex;

  const { data, error } = await storeDb()
    .from('app_aliases')
    .insert(payload)
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') {
      return {
        ok: false,
        error: { code: 'ALIAS_DUPLICATE', message: 'This alias already exists for the app' },
      };
    }
    console.error('[store-apps] addAliasAction:', error);
    return {
      ok: false,
      error: { code: 'DB_ERROR', message: 'Failed to add alias' },
    };
  }

  revalidatePath(APPS_PATH);
  return { ok: true, data: { id: (data as { id: string }).id } };
}

export async function removeAliasAction(input: unknown): Promise<ActionResult> {
  const guard = await guardManager();
  if ('error' in guard) return { ok: false, error: guard.error };

  const parsed = removeAliasInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: firstValidationMessage(parsed.error.issues),
      },
    };
  }

  // Block removing the last AUTO_CURRENT row — without one, email
  // classification for this app breaks silently. Users who want to orphan
  // an app should archive via deleteAppAction (active=false).
  const { data: row, error: readErr } = await storeDb()
    .from('app_aliases')
    .select('app_id, source_type')
    .eq('id', parsed.data.id)
    .maybeSingle();
  if (readErr) {
    console.error('[store-apps] removeAliasAction read:', readErr);
    return { ok: false, error: { code: 'DB_ERROR', message: 'Failed to load alias' } };
  }
  if (!row) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'Alias not found' } };
  }

  if ((row as { source_type: string }).source_type === 'AUTO_CURRENT') {
    const { count, error: cntErr } = await storeDb()
      .from('app_aliases')
      .select('id', { count: 'exact', head: true })
      .eq('app_id', (row as { app_id: string }).app_id)
      .eq('source_type', 'AUTO_CURRENT');
    if (cntErr) {
      console.error('[store-apps] removeAliasAction count:', cntErr);
      return { ok: false, error: { code: 'DB_ERROR', message: 'Failed to check aliases' } };
    }
    if ((count ?? 0) <= 1) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION',
          message: 'Cannot remove the last AUTO_CURRENT alias — rename the app instead',
        },
      };
    }
  }

  const { error } = await storeDb()
    .from('app_aliases')
    .delete()
    .eq('id', parsed.data.id);
  if (error) {
    console.error('[store-apps] removeAliasAction delete:', error);
    return { ok: false, error: { code: 'DB_ERROR', message: 'Failed to remove alias' } };
  }

  revalidatePath(APPS_PATH);
  return { ok: true, data: undefined };
}

// -- Platform bindings -----------------------------------------------------

export async function setPlatformBindingAction(input: unknown): Promise<ActionResult> {
  const guard = await guardManager();
  if ('error' in guard) return { ok: false, error: guard.error };

  const parsed = setPlatformBindingInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: firstValidationMessage(parsed.error.issues),
      },
    };
  }

  const platformId = await platformIdForKey(parsed.data.platform);
  if (!platformId) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_PLATFORM',
        message: `Platform "${parsed.data.platform}" is not registered`,
      },
    };
  }

  const { error } = await storeDb()
    .from('app_platform_bindings')
    .upsert(
      {
        app_id: parsed.data.app_id,
        platform_id: platformId,
        platform_ref: parsed.data.platform_ref ?? null,
        console_url: parsed.data.console_url ?? null,
      },
      { onConflict: 'app_id,platform_id' },
    );

  if (error) {
    console.error('[store-apps] setPlatformBindingAction:', error);
    return { ok: false, error: { code: 'DB_ERROR', message: 'Failed to save binding' } };
  }

  revalidatePath(APPS_PATH);
  return { ok: true, data: undefined };
}

export async function removePlatformBindingAction(input: unknown): Promise<ActionResult> {
  const guard = await guardManager();
  if ('error' in guard) return { ok: false, error: guard.error };

  const parsed = removePlatformBindingInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: firstValidationMessage(parsed.error.issues),
      },
    };
  }

  const platformId = await platformIdForKey(parsed.data.platform);
  if (!platformId) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_PLATFORM',
        message: `Platform "${parsed.data.platform}" is not registered`,
      },
    };
  }

  const { error } = await storeDb()
    .from('app_platform_bindings')
    .delete()
    .eq('app_id', parsed.data.app_id)
    .eq('platform_id', platformId);

  if (error) {
    console.error('[store-apps] removePlatformBindingAction:', error);
    return { ok: false, error: { code: 'DB_ERROR', message: 'Failed to remove binding' } };
  }

  revalidatePath(APPS_PATH);
  return { ok: true, data: undefined };
}

// -- CSV import / export ---------------------------------------------------

export type CsvImportPreview = {
  mode: 'preview';
  total_rows: number;
  valid_rows: number;
  error_rows: ReturnType<typeof parseAppRegistryCsv>['errors'];
  existing_slugs: string[];
  unknown_owner_emails: string[];
};

export type CsvImportCommit = {
  mode: 'commit';
  created: Array<{ rowNumber: number; app_id: string; slug: string }>;
  skipped: Array<{ rowNumber: number; slug: string; reason: string }>;
  errors: Array<{ rowNumber: number; slug: string; code: string; message: string }>;
};

/**
 * 2-step CSV import. When `confirm=false` (default) the action returns a
 * preview report without touching the DB; the UI uses it to render a diff
 * dialog. When `confirm=true` the action calls `import_apps_csv_tx` which
 * executes atomically at the row level (individual row errors collected into
 * the report; unexpected errors roll back the whole call).
 */
export async function importAppsCsvAction(
  input: unknown,
): Promise<ActionResult<CsvImportPreview | CsvImportCommit>> {
  const guard = await guardManager();
  if ('error' in guard) return { ok: false, error: guard.error };

  const parsed = importCsvInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: firstValidationMessage(parsed.error.issues),
      },
    };
  }

  // Guard against oversized CSV before handing to papaparse. Matches the
  // API route contract in docs §A.9.5 (≤2MB).
  const TWO_MB = 2 * 1024 * 1024;
  if (parsed.data.csv_text.length > TWO_MB) {
    return {
      ok: false,
      error: { code: 'CSV_FATAL', message: 'CSV exceeds 2MB limit' },
    };
  }

  const parseResult = parseAppRegistryCsv(parsed.data.csv_text);
  if (parseResult.fatal) {
    return {
      ok: false,
      error: { code: 'CSV_FATAL', message: parseResult.fatal },
    };
  }

  // Resolve slugs for each valid row: caller UX doesn't provide slug, so we
  // derive from name (same rule as createAppAction).
  const rowsWithSlug = parseResult.valid.map((r) => {
    try {
      return { ...r, slug: generateSlugFromName(r.data.name) };
    } catch (err) {
      const message = err instanceof InvalidSlugError ? err.message : 'invalid name';
      return { ...r, slug: null as string | null, slugError: message };
    }
  });

  const slugErrors = rowsWithSlug
    .filter((r) => r.slug == null)
    .map((r) => ({
      rowNumber: r.rowNumber,
      raw: r.raw,
      errors: [{ path: 'name', message: (r as { slugError: string }).slugError }],
    }));

  const { data: existingRows, error: existingErr } = await storeDb()
    .from('apps')
    .select('slug')
    .in(
      'slug',
      rowsWithSlug.filter((r) => r.slug).map((r) => r.slug as string),
    );
  if (existingErr) {
    console.error('[store-apps] importAppsCsvAction existing check:', existingErr);
    return { ok: false, error: { code: 'DB_ERROR', message: 'Failed to check existing apps' } };
  }
  const existingSlugs = new Set(
    (existingRows ?? []).map((r) => (r as { slug: string }).slug),
  );

  const ownerEmails = Array.from(
    new Set(
      parseResult.valid
        .map((r) => r.data.team_owner_email)
        .filter((e): e is string => typeof e === 'string' && e.length > 0),
    ),
  );
  const { data: ownerRows, error: ownerErr } = await storeDb()
    .from('users')
    .select('id, email')
    .in('email', ownerEmails.length > 0 ? ownerEmails : ['__none__']);
  if (ownerErr) {
    console.error('[store-apps] importAppsCsvAction owners:', ownerErr);
    return { ok: false, error: { code: 'DB_ERROR', message: 'Failed to resolve owners' } };
  }
  const ownerIdByEmail = new Map<string, string>(
    (ownerRows ?? []).map((r) => {
      const row = r as { id: string; email: string };
      return [row.email.toLowerCase(), row.id];
    }),
  );
  const unknownOwnerEmails = ownerEmails.filter(
    (e) => !ownerIdByEmail.has(e.toLowerCase()),
  );

  if (!parsed.data.confirm) {
    return {
      ok: true,
      data: {
        mode: 'preview',
        total_rows: parseResult.valid.length + parseResult.errors.length,
        valid_rows: rowsWithSlug.filter((r) => r.slug).length,
        error_rows: [...parseResult.errors, ...slugErrors],
        existing_slugs: [...existingSlugs],
        unknown_owner_emails: unknownOwnerEmails,
      },
    };
  }

  // Commit path. Shape each valid row for the RPC.
  const rpcRows = rowsWithSlug
    .filter((r): r is typeof r & { slug: string } => typeof r.slug === 'string')
    .map((r) => {
      const d = r.data;
      const bindings: Array<{ platform_key: PlatformKey; platform_ref?: string }> = [];
      if (d.apple_bundle_id) bindings.push({ platform_key: 'apple', platform_ref: d.apple_bundle_id });
      if (d.google_package_name) bindings.push({ platform_key: 'google', platform_ref: d.google_package_name });
      if (d.huawei_app_id) bindings.push({ platform_key: 'huawei', platform_ref: d.huawei_app_id });
      if (d.facebook_app_id) bindings.push({ platform_key: 'facebook', platform_ref: d.facebook_app_id });

      return {
        rowNumber: r.rowNumber,
        slug: r.slug,
        name: d.name,
        display_name: d.display_name ?? null,
        aliases: d.aliases,
        platform_bindings: bindings,
        team_owner_id: d.team_owner_email
          ? ownerIdByEmail.get(d.team_owner_email.toLowerCase()) ?? null
          : null,
        active: d.active,
      };
    });

  const { data: rpcReport, error: rpcErr } = await storeDb().rpc('import_apps_csv_tx', {
    p_rows: rpcRows,
    p_imported_by: guard.user.id,
    p_strategy: parsed.data.strategy,
  });

  if (rpcErr) {
    const mapped = mapRpcError(rpcErr.message);
    if (mapped) return { ok: false, error: mapped };
    console.error('[store-apps] importAppsCsvAction rpc:', rpcErr);
    return { ok: false, error: { code: 'DB_ERROR', message: 'CSV import failed' } };
  }

  revalidatePath(APPS_PATH);
  const report = rpcReport as {
    created: Array<{ rowNumber: number; app_id: string; slug: string }>;
    skipped: Array<{ rowNumber: number; slug: string; reason: string }>;
    errors: Array<{ rowNumber: number; slug: string; code: string; message: string }>;
  };
  return {
    ok: true,
    data: {
      mode: 'commit',
      created: report.created ?? [],
      skipped: report.skipped ?? [],
      errors: report.errors ?? [],
    },
  };
}

// -- Export ----------------------------------------------------------------

/**
 * Produce a CSV export of all apps + aliases + platform bindings matching
 * `templates/app-registry-template.csv` column order. The caller (API Route
 * for HTTP response with Content-Disposition, or dialog for in-page download)
 * is responsible for surface; this action just returns the serialized CSV.
 */
export async function exportAppsCsvAction(): Promise<
  ActionResult<{ csv: string; filename: string }>
> {
  const session = await getServerSession(authOptions);
  try {
    await requireStoreRole(session?.user?.email, ['MANAGER', 'DEV', 'VIEWER']);
  } catch (err) {
    if (err instanceof StoreUnauthorizedError) {
      return { ok: false, error: { code: 'UNAUTHORIZED', message: err.message } };
    }
    if (err instanceof StoreForbiddenError) {
      return { ok: false, error: { code: 'FORBIDDEN', message: err.message } };
    }
    throw err;
  }

  const db = storeDb();
  const [appsRes, aliasesRes, bindingsRes, platformsRes, ownersRes] = await Promise.all([
    db
      .from('apps')
      .select('id, slug, name, display_name, team_owner_id, active')
      .order('name', { ascending: true }),
    db
      .from('app_aliases')
      .select('app_id, alias_text, source_type')
      .in('source_type', ['MANUAL', 'AUTO_HISTORICAL']),
    db
      .from('app_platform_bindings')
      .select('app_id, platform_id, platform_ref'),
    db.from('platforms').select('id, key'),
    db.from('users').select('id, email'),
  ]);

  for (const r of [appsRes, aliasesRes, bindingsRes, platformsRes, ownersRes]) {
    if (r.error) {
      console.error('[store-apps] exportAppsCsvAction:', r.error);
      return { ok: false, error: { code: 'DB_ERROR', message: 'Failed to load export data' } };
    }
  }

  const platformKeyById = new Map<string, PlatformKey>();
  for (const p of platformsRes.data ?? []) {
    const row = p as { id: string; key: PlatformKey };
    platformKeyById.set(row.id, row.key);
  }
  const ownerEmailById = new Map<string, string>();
  for (const u of ownersRes.data ?? []) {
    const row = u as { id: string; email: string };
    ownerEmailById.set(row.id, row.email);
  }
  const aliasesByApp = new Map<string, string[]>();
  for (const a of aliasesRes.data ?? []) {
    const row = a as { app_id: string; alias_text: string | null };
    if (!row.alias_text) continue;
    const bucket = aliasesByApp.get(row.app_id) ?? [];
    bucket.push(row.alias_text);
    aliasesByApp.set(row.app_id, bucket);
  }
  const bindingsByApp = new Map<string, Map<PlatformKey, string>>();
  for (const b of bindingsRes.data ?? []) {
    const row = b as { app_id: string; platform_id: string; platform_ref: string | null };
    const key = platformKeyById.get(row.platform_id);
    if (!key) continue;
    const bucket = bindingsByApp.get(row.app_id) ?? new Map<PlatformKey, string>();
    if (row.platform_ref) bucket.set(key, row.platform_ref);
    bindingsByApp.set(row.app_id, bucket);
  }

  const header = [
    'name',
    'display_name',
    'aliases',
    'apple_bundle_id',
    'google_package_name',
    'huawei_app_id',
    'facebook_app_id',
    'team_owner_email',
    'active',
  ];

  const rows = (appsRes.data ?? []).map((a) => {
    const app = a as {
      id: string;
      slug: string;
      name: string;
      display_name: string | null;
      team_owner_id: string | null;
      active: boolean;
    };
    const bindings = bindingsByApp.get(app.id) ?? new Map<PlatformKey, string>();
    return [
      app.name,
      app.display_name ?? '',
      (aliasesByApp.get(app.id) ?? []).join('|'),
      bindings.get('apple') ?? '',
      bindings.get('google') ?? '',
      bindings.get('huawei') ?? '',
      bindings.get('facebook') ?? '',
      app.team_owner_id ? ownerEmailById.get(app.team_owner_id) ?? '' : '',
      app.active ? 'true' : 'false',
    ];
  });

  const csv = [header, ...rows].map(serializeCsvRow).join('\n');
  const today = new Date().toISOString().slice(0, 10);
  return {
    ok: true,
    data: { csv, filename: `app-registry-${today}.csv` },
  };
}

function serializeCsvRow(row: string[]): string {
  return row
    .map((v) => {
      if (v == null) return '';
      const s = String(v);
      if (s.includes('"') || s.includes(',') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    })
    .join(',');
}
