/**
 * Slug schema — extracted into its own module so Client Components can
 * validate slug input without pulling `re2-wasm` (which lives behind
 * `validateAliasRegex` in this folder's `app.ts`) into the browser bundle.
 *
 * `schemas/app.ts` re-exports `slugSchema` from here so existing server-side
 * imports (`from '@/lib/store-submissions/schemas/app'`) keep working.
 */

import { z } from 'zod';

/**
 * Slug format: URL-friendly ASCII.
 *   - lowercase letters, digits, hyphens
 *   - no leading/trailing/consecutive hyphens
 *   - 1..50 chars (suffix room for collision resolution at the action layer)
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
