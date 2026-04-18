'use server';

import { revalidatePath } from 'next/cache';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import {
  StoreForbiddenError,
  StoreUnauthorizedError,
  requireStoreRole,
} from '@/lib/store-submissions/auth';
import { storeDb } from '@/lib/store-submissions/db';
import {
  createUserSchema,
  disableUserSchema,
  normalizeDisplayName,
  updateUserSchema,
} from '@/lib/store-submissions/schemas/user';

export type ActionError = {
  code:
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'VALIDATION'
    | 'EMAIL_TAKEN'
    | 'NOT_FOUND'
    | 'LAST_MANAGER'
    | 'DB_ERROR';
  message: string;
};

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: ActionError };

const TEAM_PATH = '/store-submissions/config/team';

async function guardManager(): Promise<ActionError | null> {
  const session = await getServerSession(authOptions);
  try {
    await requireStoreRole(session?.user?.email, 'MANAGER');
    return null;
  } catch (err) {
    if (err instanceof StoreUnauthorizedError) {
      return { code: 'UNAUTHORIZED', message: err.message };
    }
    if (err instanceof StoreForbiddenError) {
      return { code: 'FORBIDDEN', message: err.message };
    }
    throw err;
  }
}

function firstValidationMessage(issues: { message: string }[]): string {
  return issues[0]?.message ?? 'Invalid input';
}

function mapRpcError(message: string): ActionError | null {
  if (message.includes('LAST_MANAGER')) {
    return {
      code: 'LAST_MANAGER',
      message: 'Cannot leave module without an active MANAGER',
    };
  }
  if (message.includes('NOT_FOUND')) {
    return { code: 'NOT_FOUND', message: 'User not found' };
  }
  return null;
}

export async function createUser(
  input: unknown
): Promise<ActionResult<{ id: string }>> {
  const denial = await guardManager();
  if (denial) return { ok: false, error: denial };

  const parsed = createUserSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: firstValidationMessage(parsed.error.issues),
      },
    };
  }

  const { data, error } = await storeDb()
    .from('users')
    .insert({
      email: parsed.data.email,
      role: parsed.data.role,
      display_name: normalizeDisplayName(parsed.data.display_name),
    })
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') {
      return {
        ok: false,
        error: { code: 'EMAIL_TAKEN', message: 'Email already exists' },
      };
    }
    console.error('[store-team] createUser:', error);
    return {
      ok: false,
      error: { code: 'DB_ERROR', message: 'Failed to create user' },
    };
  }

  revalidatePath(TEAM_PATH);
  return { ok: true, data: { id: data.id as string } };
}

export async function updateUser(input: unknown): Promise<ActionResult> {
  const denial = await guardManager();
  if (denial) return { ok: false, error: denial };

  const parsed = updateUserSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: firstValidationMessage(parsed.error.issues),
      },
    };
  }

  const { error } = await storeDb().rpc('update_user_guarded', {
    p_id: parsed.data.id,
    p_role: parsed.data.role ?? null,
    p_status: parsed.data.status ?? null,
    p_display_name:
      parsed.data.display_name === undefined
        ? null
        : normalizeDisplayName(parsed.data.display_name),
  });

  if (error) {
    const mapped = mapRpcError(error.message ?? '');
    if (mapped) return { ok: false, error: mapped };
    console.error('[store-team] updateUser:', error);
    return {
      ok: false,
      error: { code: 'DB_ERROR', message: 'Failed to update user' },
    };
  }

  revalidatePath(TEAM_PATH);
  return { ok: true, data: undefined };
}

export async function disableUser(input: unknown): Promise<ActionResult> {
  const denial = await guardManager();
  if (denial) return { ok: false, error: denial };

  const parsed = disableUserSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: firstValidationMessage(parsed.error.issues),
      },
    };
  }

  const { error } = await storeDb().rpc('update_user_guarded', {
    p_id: parsed.data.id,
    p_role: null,
    p_status: 'disabled',
    p_display_name: null,
  });

  if (error) {
    const mapped = mapRpcError(error.message ?? '');
    if (mapped) return { ok: false, error: mapped };
    console.error('[store-team] disableUser:', error);
    return {
      ok: false,
      error: { code: 'DB_ERROR', message: 'Failed to disable user' },
    };
  }

  revalidatePath(TEAM_PATH);
  return { ok: true, data: undefined };
}
