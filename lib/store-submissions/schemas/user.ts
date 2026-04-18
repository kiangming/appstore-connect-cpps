/**
 * Zod schemas for Store Management user CRUD.
 *
 * Shared client/server — used by react-hook-form resolver, Server Actions,
 * and API validation.
 */

import { z } from 'zod';

export const storeRoleSchema = z.enum(['MANAGER', 'DEV', 'VIEWER']);
export type StoreRoleInput = z.infer<typeof storeRoleSchema>;

export const storeUserStatusSchema = z.enum(['active', 'disabled']);
export type StoreUserStatus = z.infer<typeof storeUserStatusSchema>;

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Email is required')
  .email('Invalid email')
  .max(254, 'Email too long');

const displayNameField = z
  .string()
  .trim()
  .max(120, 'Display name too long')
  .optional();

export const createUserSchema = z.object({
  email: emailField,
  role: storeRoleSchema,
  display_name: displayNameField,
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  id: z.string().uuid('Invalid user id'),
  role: storeRoleSchema.optional(),
  display_name: displayNameField,
  status: storeUserStatusSchema.optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

/**
 * Form-only schema for the edit dialog: role + status are required because
 * the <select> always has a value. The Server Action still uses
 * updateUserSchema (partial) — the dialog diffs against the original user
 * and only passes changed fields.
 */
export const editUserFormSchema = z.object({
  id: z.string().uuid('Invalid user id'),
  role: storeRoleSchema,
  status: storeUserStatusSchema,
  display_name: displayNameField,
});
export type EditUserFormInput = z.infer<typeof editUserFormSchema>;

/** Treat empty string as null for DB writes. */
export function normalizeDisplayName(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const disableUserSchema = z.object({
  id: z.string().uuid('Invalid user id'),
});
export type DisableUserInput = z.infer<typeof disableUserSchema>;
