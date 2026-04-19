/**
 * Zod schemas for the Store Management email rule engine.
 *
 * Mirrors store_mgmt schema in docs/store-submissions/01-data-model.md §2.2:
 *   - senders (platform_id, email, is_primary, active)
 *   - subject_patterns (outcome, regex, priority, example_subject, active)
 *   - types (name, slug, body_keyword, payload_extract_regex?, sort_order, active)
 *   - submission_id_patterns (body_regex, active)
 *   - rule_versions (platform_id, version_number, config_snapshot JSONB)
 *
 * Regex refinements defer to lib/store-submissions/regex/validators, which
 * wraps RE2 compilation + named-group checks. JS-style `(?<name>...)` and
 * Python-style `(?P<name>...)` named groups are both accepted — the Apple
 * seed in supabase/migrations/20260101100200_store_mgmt_seed_apple_rules.sql
 * uses JS-style; RE2 accepts both internally.
 *
 * See docs/store-submissions/03-email-rule-engine.md §4.4 and §7.
 */

import { z } from 'zod';

import {
  validatePayloadRegex,
  validateSubjectPattern,
  validateSubmissionIdPattern,
} from '../regex/validators';

// -- Shared --------------------------------------------------------------

export const outcomeSchema = z.enum(['APPROVED', 'REJECTED', 'IN_REVIEW']);
export type Outcome = z.infer<typeof outcomeSchema>;

const uuidField = z.string().uuid('Invalid id');
const platformIdField = z.string().uuid('Invalid platform_id');

/**
 * Slug format for `types.slug` — URL-safe ASCII, identical rules to app
 * slugs but with its own type-level uniqueness (platform_id, slug).
 */
export const typeSlugSchema = z
  .string()
  .trim()
  .min(1, 'Slug is required')
  .max(50, 'Slug must be 50 characters or fewer')
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    'Slug must be lowercase ASCII letters, digits, and single hyphens',
  );

const regexField = (max = 1000) =>
  z.string().trim().min(1, 'Regex is required').max(max, 'Regex too long');

// -- Senders -------------------------------------------------------------

/**
 * Senders are matched against normalized (lowercase, trimmed) sender email
 * in the classifier. We mirror that here so two rows like
 *   "No-Reply@Apple.com"
 *   "no-reply@apple.com"
 * never get saved as distinct records.
 */
const senderEmailField = z
  .string()
  .trim()
  .toLowerCase()
  .email('Invalid email')
  .max(320, 'Email too long');

export const senderInputSchema = z.object({
  id: uuidField.optional(),
  email: senderEmailField,
  is_primary: z.boolean().default(false),
  active: z.boolean().default(true),
});
export type SenderInput = z.infer<typeof senderInputSchema>;

// -- Subject patterns ----------------------------------------------------

export const subjectPatternInputSchema = z
  .object({
    id: uuidField.optional(),
    outcome: outcomeSchema,
    regex: regexField(),
    priority: z.number().int().min(0).max(10_000).default(100),
    example_subject: z.string().trim().max(500).optional().nullable(),
    active: z.boolean().default(true),
  })
  .superRefine((d, ctx) => {
    const r = validateSubjectPattern(d.regex);
    if (!r.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: r.error,
        path: ['regex'],
      });
    }
  });
export type SubjectPatternInput = z.infer<typeof subjectPatternInputSchema>;

// -- Types ---------------------------------------------------------------

/**
 * `types.payload_extract_regex` is optional at the DB level: some types are
 * plain keyword-only (no payload capture). When present, it must compile
 * under RE2 — named groups are allowed but not required (per spec §4.4).
 */
export const typeInputSchema = z
  .object({
    id: uuidField.optional(),
    name: z.string().trim().min(1, 'Name is required').max(100, 'Name too long'),
    slug: typeSlugSchema,
    body_keyword: z
      .string()
      .trim()
      .min(1, 'Body keyword is required')
      .max(200, 'Body keyword too long'),
    payload_extract_regex: regexField().optional().nullable(),
    sort_order: z.number().int().min(0).max(10_000).default(100),
    active: z.boolean().default(true),
  })
  .superRefine((d, ctx) => {
    if (!d.payload_extract_regex) return;
    const r = validatePayloadRegex(d.payload_extract_regex);
    if (!r.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: r.error,
        path: ['payload_extract_regex'],
      });
    }
  });
export type TypeInput = z.infer<typeof typeInputSchema>;

// -- Submission ID patterns ----------------------------------------------

export const submissionIdPatternInputSchema = z
  .object({
    id: uuidField.optional(),
    body_regex: regexField(),
    active: z.boolean().default(true),
  })
  .superRefine((d, ctx) => {
    const r = validateSubmissionIdPattern(d.body_regex);
    if (!r.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: r.error,
        path: ['body_regex'],
      });
    }
  });
export type SubmissionIdPatternInput = z.infer<typeof submissionIdPatternInputSchema>;

// -- Bulk save (one transaction per platform) ----------------------------

/**
 * Input for `saveRulesAction` — replaces *all four* rule sets for a single
 * platform atomically. The RPC deletes existing rows in the four tables
 * (scoped to platform_id), inserts the new ones, and appends a
 * rule_versions snapshot.
 *
 * Why "replace all" instead of per-rule CRUD:
 *   - Makes the version snapshot trivially correct (snapshot == saved input)
 *   - Avoids foreign-key edge cases when reordering or renaming slugs
 *   - Matches the UI shape (one form per platform, saved as a unit)
 *
 * Callers that only want to tweak one rule still send the full set — the UI
 * holds draft state and submits everything.
 */
export const saveRulesInputSchema = z
  .object({
    platform_id: platformIdField,
    /**
     * Optimistic-lock guard: the version_number the client thinks it's
     * saving *on top of*. `null` means "no prior save exists for this
     * platform" (truly the first commit). The RPC compares against the
     * current MAX(version_number) under FOR UPDATE on platforms — mismatch
     * raises VERSION_CONFLICT. Clients read `latest_version` from
     * getRulesForPlatform on page load and pass it back on save.
     */
    expected_version_number: z
      .number()
      .int()
      .positive('expected_version_number must be positive or null')
      .nullable(),
    senders: z.array(senderInputSchema).max(50, 'Too many senders'),
    subject_patterns: z
      .array(subjectPatternInputSchema)
      .max(100, 'Too many subject patterns'),
    types: z.array(typeInputSchema).max(100, 'Too many types'),
    submission_id_patterns: z
      .array(submissionIdPatternInputSchema)
      .max(50, 'Too many submission_id patterns'),
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((d, ctx) => {
    // DB has UNIQUE(platform_id, email) on senders and UNIQUE(platform_id, slug)
    // on types. Catch duplicates client-side so the user sees per-row errors
    // instead of a generic 23505 from the RPC.
    const senderEmails = new Set<string>();
    d.senders.forEach((s, idx) => {
      const key = s.email;
      if (senderEmails.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate sender email "${key}"`,
          path: ['senders', idx, 'email'],
        });
      }
      senderEmails.add(key);
    });

    const typeSlugs = new Set<string>();
    d.types.forEach((t, idx) => {
      if (typeSlugs.has(t.slug)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate type slug "${t.slug}"`,
          path: ['types', idx, 'slug'],
        });
      }
      typeSlugs.add(t.slug);
    });
  });
export type SaveRulesInput = z.infer<typeof saveRulesInputSchema>;

// -- Versioning ----------------------------------------------------------

export const rollbackRulesInputSchema = z.object({
  platform_id: platformIdField,
  target_version: z.number().int().positive('target_version must be positive'),
  note: z.string().trim().max(500).optional(),
});
export type RollbackRulesInput = z.infer<typeof rollbackRulesInputSchema>;

export const listVersionsInputSchema = z.object({
  platform_id: platformIdField,
  limit: z.number().int().min(1).max(100).default(50),
});
export type ListVersionsInput = z.infer<typeof listVersionsInputSchema>;

export const getVersionInputSchema = z.object({
  platform_id: platformIdField,
  version_number: z.number().int().positive(),
});
export type GetVersionInput = z.infer<typeof getVersionInputSchema>;

// -- Config snapshot shape (stored in rule_versions.config_snapshot) -----

/**
 * Shape of `rule_versions.config_snapshot`. Stored verbatim at save time
 * so rollback replays the *exact* rule set that was saved, regardless of
 * later schema evolution. Writers must match this shape; readers SHOULD
 * validate before consuming (old snapshots may lack newly-added fields).
 *
 * The `id` fields are captured but *not* replayed on rollback — a rollback
 * re-inserts rows with fresh UUIDs (see spec §7.2). They live in the
 * snapshot purely for audit ("which pattern_id matched at classify time?").
 */
export const configSnapshotSchema = z.object({
  schema_version: z.literal(1),
  senders: z.array(
    z.object({
      id: uuidField,
      email: z.string(),
      is_primary: z.boolean(),
      active: z.boolean(),
    }),
  ),
  subject_patterns: z.array(
    z.object({
      id: uuidField,
      outcome: outcomeSchema,
      regex: z.string(),
      priority: z.number().int(),
      example_subject: z.string().nullable(),
      active: z.boolean(),
    }),
  ),
  types: z.array(
    z.object({
      id: uuidField,
      name: z.string(),
      slug: z.string(),
      body_keyword: z.string(),
      payload_extract_regex: z.string().nullable(),
      sort_order: z.number().int(),
      active: z.boolean(),
    }),
  ),
  submission_id_patterns: z.array(
    z.object({
      id: uuidField,
      body_regex: z.string(),
      active: z.boolean(),
    }),
  ),
});
export type ConfigSnapshot = z.infer<typeof configSnapshotSchema>;
