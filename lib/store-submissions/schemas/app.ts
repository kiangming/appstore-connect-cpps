/**
 * Zod schemas for the Store Management app registry.
 *
 * Mirrors store_mgmt schema in docs/store-submissions/01-data-model.md §2.2:
 *   - apps (slug, name, display_name, team_owner_id, active)
 *   - app_aliases (alias_text XOR alias_regex, source_type enum)
 *   - app_platform_bindings (platform_ref by platform key)
 *   - CSV row format matches templates/app-registry-template.csv
 *
 * Shared client/server: used by react-hook-form resolvers, Server Actions,
 * and the CSV import path in PR-4.
 */

import { z } from 'zod';

import { validateAliasRegex } from '../regex/validators';

// -- Shared fields ----------------------------------------------------------

export const aliasSourceTypeSchema = z.enum([
  'AUTO_CURRENT',
  'AUTO_HISTORICAL',
  'MANUAL',
  'REGEX',
]);
export type AliasSourceType = z.infer<typeof aliasSourceTypeSchema>;

export const platformKeySchema = z.enum(['apple', 'google', 'huawei', 'facebook']);
export type PlatformKey = z.infer<typeof platformKeySchema>;

/**
 * Slug format: URL-friendly ASCII.
 *   - lowercase letters, digits, hyphens
 *   - no leading/trailing/consecutive hyphens
 *   - 1..50 chars (suffix room for collision resolution in PR-4)
 */
export const slugSchema = z
  .string()
  .trim()
  .min(1, 'Slug is required')
  .max(50, 'Slug must be 50 characters or fewer')
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    'Slug must be lowercase ASCII letters, digits, and single hyphens',
  );

const nameField = z.string().trim().min(1, 'Name is required').max(200, 'Name too long');
const displayNameField = z.string().trim().max(200, 'Display name too long').optional();

// -- Platform bindings ------------------------------------------------------

export const platformBindingInputSchema = z.object({
  platform: platformKeySchema,
  platform_ref: z.string().trim().min(1, 'platform_ref cannot be empty').optional(),
  console_url: z
    .string()
    .trim()
    .url('console_url must be a valid URL')
    .optional(),
});
export type PlatformBindingInput = z.infer<typeof platformBindingInputSchema>;

// -- Aliases ---------------------------------------------------------------

const aliasObjectSchema = z.object({
  alias_text: z.string().trim().min(1).max(200).optional(),
  alias_regex: z.string().trim().min(1).max(500).optional(),
  source_type: aliasSourceTypeSchema,
  previous_name: z.string().trim().min(1).max(200).optional(),
});

/**
 * Alias invariants (mirrors CHECK constraints in app_aliases):
 *   1. exactly one of alias_text / alias_regex is set
 *   2. AUTO_HISTORICAL rows must carry previous_name
 *   3. REGEX source_type must use alias_regex
 *   4. alias_regex (when present) must pass validateAliasRegex
 */
export const aliasSchema = aliasObjectSchema
  .refine((d) => (d.alias_text != null) !== (d.alias_regex != null), {
    message: 'Exactly one of alias_text or alias_regex must be set',
  })
  .refine((d) => d.source_type !== 'AUTO_HISTORICAL' || !!d.previous_name, {
    message: 'AUTO_HISTORICAL aliases require previous_name',
    path: ['previous_name'],
  })
  .refine((d) => d.source_type !== 'REGEX' || !!d.alias_regex, {
    message: 'REGEX source_type requires alias_regex',
    path: ['alias_regex'],
  })
  .refine(
    (d) => {
      if (!d.alias_regex) return true;
      return validateAliasRegex(d.alias_regex).ok;
    },
    {
      message: 'alias_regex must be a valid, non-permissive RE2 pattern',
      path: ['alias_regex'],
    },
  );
export type AliasInput = z.infer<typeof aliasSchema>;

// -- Create / update app ---------------------------------------------------

export const createAppSchema = z.object({
  name: nameField,
  display_name: displayNameField,
  slug: slugSchema,
  team_owner_id: z.string().uuid('Invalid team_owner_id').nullable().optional(),
  active: z.boolean().default(true),
  platform_bindings: z.array(platformBindingInputSchema).default([]),
});
export type CreateAppInput = z.infer<typeof createAppSchema>;

export const updateAppSchema = z.object({
  id: z.string().uuid('Invalid app id'),
  name: nameField.optional(),
  display_name: displayNameField,
  slug: slugSchema.optional(),
  team_owner_id: z.string().uuid('Invalid team_owner_id').nullable().optional(),
  active: z.boolean().optional(),
});
export type UpdateAppInput = z.infer<typeof updateAppSchema>;

// -- CSV row ---------------------------------------------------------------

/**
 * Columns from templates/app-registry-template.csv:
 *   name, display_name, aliases, apple_bundle_id, google_package_name,
 *   huawei_app_id, facebook_app_id, team_owner_email, active
 *
 * Normalization rules:
 *   - empty string → undefined (except `name`, which is required)
 *   - `aliases` pipe-separated (e.g. "Skyline|Skyline Runners: Endless")
 *   - `active` accepts "true"/"false"/"1"/"0"/"yes"/"no" (case-insensitive)
 *   - `team_owner_email` validated here; resolution to UUID happens at ingest
 */
const emptyToUndef = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const csvText = (max = 200) =>
  z.preprocess(
    emptyToUndef,
    z.string().trim().max(max).optional(),
  );

const csvBool = z.preprocess(
  (v) => {
    if (typeof v !== 'string') return v;
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
    return v;
  },
  z.boolean(),
);

const csvAliases = z.preprocess(
  (v) => {
    if (typeof v !== 'string' || v.trim() === '') return [] as string[];
    return v
      .split('|')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  },
  z.array(z.string().min(1).max(200)).default([]),
);

const csvEmail = z.preprocess(
  emptyToUndef,
  z.string().trim().toLowerCase().email('Invalid team_owner_email').optional(),
);

export const csvRowSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(200),
  display_name: csvText(200),
  aliases: csvAliases,
  apple_bundle_id: csvText(200),
  google_package_name: csvText(200),
  huawei_app_id: csvText(200),
  facebook_app_id: csvText(200),
  team_owner_email: csvEmail,
  active: csvBool,
});
export type CsvRowInput = z.infer<typeof csvRowSchema>;

// -- Server Action input schemas ------------------------------------------

const uuidField = z.string().uuid('Invalid id');

/**
 * Looser variant of `createAppSchema` consumed by the Server Action:
 *   - `slug` is optional — when omitted, the action derives it from `name`
 *     via generateSlugFromName and applies collision-resolution before the
 *     RPC INSERT. When provided, it is validated verbatim.
 * The stricter `createAppSchema` (slug required) remains for other callers
 * and continues to gate inputs at the API boundary.
 */
export const createAppActionInputSchema = z.object({
  name: nameField,
  display_name: displayNameField,
  slug: slugSchema.optional(),
  team_owner_id: z.string().uuid('Invalid team_owner_id').nullable().optional(),
  active: z.boolean().default(true),
  platform_bindings: z.array(platformBindingInputSchema).default([]),
});
export type CreateAppActionInput = z.infer<typeof createAppActionInputSchema>;

export const renameAppInputSchema = z.object({
  id: uuidField,
  new_name: nameField,
});
export type RenameAppInput = z.infer<typeof renameAppInputSchema>;

export const deleteAppInputSchema = z.object({
  id: uuidField,
  hard: z.boolean().default(false),
});
export type DeleteAppInput = z.infer<typeof deleteAppInputSchema>;

/**
 * Alias add — same refinements as `aliasSchema` but keyed to an app_id and
 * without the AUTO_* source types (users can only add MANUAL text or REGEX
 * patterns via this entry point; AUTO_CURRENT / AUTO_HISTORICAL are managed
 * by the rename transaction).
 */
export const addAliasInputSchema = z
  .object({
    app_id: uuidField,
    alias_text: z.string().trim().min(1).max(200).optional(),
    alias_regex: z.string().trim().min(1).max(500).optional(),
    source_type: z.enum(['MANUAL', 'REGEX']),
  })
  .refine((d) => (d.alias_text != null) !== (d.alias_regex != null), {
    message: 'Exactly one of alias_text or alias_regex must be set',
  })
  .refine((d) => d.source_type !== 'REGEX' || !!d.alias_regex, {
    message: 'REGEX source_type requires alias_regex',
    path: ['alias_regex'],
  })
  .refine(
    (d) => {
      if (!d.alias_regex) return true;
      return validateAliasRegex(d.alias_regex).ok;
    },
    {
      message: 'alias_regex must be a valid, non-permissive RE2 pattern',
      path: ['alias_regex'],
    },
  );
export type AddAliasInput = z.infer<typeof addAliasInputSchema>;

export const removeAliasInputSchema = z.object({
  id: uuidField,
});
export type RemoveAliasInput = z.infer<typeof removeAliasInputSchema>;

export const setPlatformBindingInputSchema = z.object({
  app_id: uuidField,
  platform: platformKeySchema,
  platform_ref: z.string().trim().min(1).max(200).optional(),
  console_url: z.string().trim().url('console_url must be a valid URL').optional(),
});
export type SetPlatformBindingInput = z.infer<typeof setPlatformBindingInputSchema>;

export const removePlatformBindingInputSchema = z.object({
  app_id: uuidField,
  platform: platformKeySchema,
});
export type RemovePlatformBindingInput = z.infer<typeof removePlatformBindingInputSchema>;

export const importCsvInputSchema = z.object({
  csv_text: z.string().min(1, 'csv_text is required'),
  confirm: z.boolean().default(false),
  strategy: z.enum(['SKIP_EXISTING', 'FAIL_ON_EXISTING']).default('SKIP_EXISTING'),
});
export type ImportCsvInput = z.infer<typeof importCsvInputSchema>;
