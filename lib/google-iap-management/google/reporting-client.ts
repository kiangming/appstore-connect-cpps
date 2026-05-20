/**
 * Play Developer Reporting API v1beta1 wrapper — apps.search only for v1.
 *
 * Q-GIAP.C: apps.search is the canonical way to enumerate Play Console
 * apps reachable by the calling service account. Default pageSize 50,
 * max 1000. nextPageToken cursor for follow-up pages.
 *
 * In contrast to the Publisher API, the Reporting API was a corrected
 * choice — early Phase 1 design called for `apps.fetch`/`apps:list` which
 * doesn't exist (404). Phase 2 discovery JSON confirmed the right path.
 */
import { google, type playdeveloperreporting_v1beta1 } from "googleapis";
import type { JWT } from "google-auth-library";

import { logReportingCall, type LogOutcome } from "./logging";

export type Reporting = playdeveloperreporting_v1beta1.Playdeveloperreporting;
export type ReportingApp =
  playdeveloperreporting_v1beta1.Schema$GooglePlayDeveloperReportingV1beta1App;
export type SearchAccessibleAppsResponse =
  playdeveloperreporting_v1beta1.Schema$GooglePlayDeveloperReportingV1beta1SearchAccessibleAppsResponse;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 1000;

function buildClient(jwt: JWT): Reporting {
  return google.playdeveloperreporting({ version: "v1beta1", auth: jwt });
}

export interface SearchAppsPage {
  apps: ReportingApp[];
  nextPageToken: string | null;
}

/**
 * Single-page apps.search. Use {@link searchAppsAll} when the caller needs
 * to walk every page.
 */
export async function searchApps(
  jwt: JWT,
  options: { pageSize?: number; pageToken?: string } = {},
): Promise<SearchAppsPage> {
  const pageSize = Math.min(
    Math.max(options.pageSize ?? DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );
  const t0 = Date.now();
  let outcome: LogOutcome = "ok";
  let status: number | undefined;
  let errTail: string | undefined;
  let resultCount: number | undefined;
  try {
    const client = buildClient(jwt);
    const res = await client.apps.search({
      pageSize,
      pageToken: options.pageToken,
    });
    const apps = (res.data.apps ?? []) as ReportingApp[];
    resultCount = apps.length;
    return {
      apps,
      nextPageToken: res.data.nextPageToken ?? null,
    };
  } catch (err) {
    outcome = "err";
    const e = err as { code?: number; status?: number; message?: string };
    status = e?.code ?? e?.status;
    errTail = (e?.message ?? String(err)).slice(0, 200);
    throw err;
  } finally {
    logReportingCall({
      method: "apps.search",
      pageSize,
      pageToken: options.pageToken,
      outcome,
      durationMs: Date.now() - t0,
      resultCount,
      status,
      errTail,
    });
  }
}

/**
 * Walk every page of apps.search and return the flattened list. Useful for
 * the Refresh button on the apps list page. Caps total iterations defensively
 * at 100 pages × 1000 = 100k apps to prevent runaway loops.
 */
export async function searchAppsAll(
  jwt: JWT,
  options: { pageSize?: number } = {},
): Promise<ReportingApp[]> {
  const pageSize = options.pageSize ?? MAX_PAGE_SIZE;
  const all: ReportingApp[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  const PAGE_CAP = 100;
  do {
    const page = await searchApps(jwt, { pageSize, pageToken });
    all.push(...page.apps);
    pageToken = page.nextPageToken ?? undefined;
    pages += 1;
    if (pages >= PAGE_CAP) break;
  } while (pageToken);
  return all;
}
