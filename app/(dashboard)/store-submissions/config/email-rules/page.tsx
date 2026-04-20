import { Rss } from 'lucide-react';

import { requireStoreSessionWithRole } from '@/lib/store-submissions/session-guard';
import {
  getPlatformByKey,
  getRulesForPlatform,
  listPlatforms,
} from '@/lib/store-submissions/queries/rules';
import { EmailRulesClient } from '@/components/store-submissions/email-rules/EmailRulesClient';
import { resolvePlatformKey } from '@/components/store-submissions/email-rules/helpers';

export const dynamic = 'force-dynamic';

/**
 * Email Rules config page — MANAGER-only. DEV/VIEWER are redirected to
 * /store-submissions/inbox by the guard (matches the Team page RBAC
 * pattern — no read-only mode for this screen).
 *
 * Data flow:
 *   1. listPlatforms() — drives the tab bar + decides which keys are
 *      interactable when the `platforms` seed is missing rows.
 *   2. resolvePlatformKey() — picks the active tab from `?platform=…`
 *      with a safe fallback to the first active platform.
 *   3. getRulesForPlatform(platformId) — full rule set + latest_version
 *      for the top-bar version badge.
 */
export default async function EmailRulesPage({
  searchParams,
}: {
  searchParams: { platform?: string | string[] };
}) {
  await requireStoreSessionWithRole('MANAGER');

  const platforms = await listPlatforms();
  const activeKey = resolvePlatformKey(searchParams.platform, platforms);

  if (activeKey === null) {
    return (
      <div className="px-8 py-10">
        <div className="max-w-5xl">
          <PageHeader />
          <div className="bg-white border border-dashed border-slate-200 rounded-xl p-6 text-[13px] text-slate-600">
            No active platforms found. Apply the Store Management seed
            migration or re-activate a platform row in{' '}
            <code className="font-mono">store_mgmt.platforms</code> to edit
            rules.
          </div>
        </div>
      </div>
    );
  }

  const platform = await getPlatformByKey(activeKey);
  if (!platform) {
    // Invariant guard: resolvePlatformKey only returns a key that appears
    // in the loaded platforms list, so this branch is unreachable unless
    // the row was deleted between the two queries (race with a migration).
    throw new Error(`Platform "${activeKey}" resolved but not found by key`);
  }

  const rules = await getRulesForPlatform(platform.id);
  if (!rules) {
    throw new Error(
      `Platform "${activeKey}" exists but getRulesForPlatform returned null`,
    );
  }

  return (
    <div className="px-8 py-10">
      <div className="max-w-7xl">
        <PageHeader />
        <EmailRulesClient
          platforms={platforms}
          activeKey={activeKey}
          initialRules={rules}
        />
      </div>
    </div>
  );
}

function PageHeader() {
  return (
    <div className="flex items-center gap-3 mb-6">
      <div className="w-10 h-10 rounded-lg bg-sky-50 flex items-center justify-center">
        <Rss className="h-5 w-5 text-sky-700" strokeWidth={1.8} />
      </div>
      <div>
        <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight">
          Email Rules
        </h1>
        <p className="text-[13px] text-slate-500">
          Senders, subject patterns, types, and submission-ID extractors per
          platform
        </p>
      </div>
    </div>
  );
}
