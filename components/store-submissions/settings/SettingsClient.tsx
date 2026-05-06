'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import {
  AlertTriangle,
  CheckCircle2,
  CircleOff,
  History,
  Loader2,
  Mail,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  disconnectGmailAction,
  getGmailConnectUrlAction,
  runBackfillAction,
  type BackfillStatus,
  type GmailStatus,
} from '@/app/(dashboard)/store-submissions/config/settings/actions';
import {
  classifyStatus,
  messageForReason,
  type GmailStatusKind,
} from './helpers';

interface SettingsClientProps {
  initialStatus: GmailStatus;
  initialBackfillStatus: BackfillStatus | null;
  isManager: boolean;
}

type StatusKind = GmailStatusKind;

export function SettingsClient({
  initialStatus,
  initialBackfillStatus,
  isManager,
}: SettingsClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isConnecting, startConnect] = useTransition();
  const [isDisconnecting, startDisconnect] = useTransition();
  const [isBackfilling, startBackfill] = useTransition();
  // Persists across renders (router.refresh preserves client state) so
  // the "more available" hint stays visible until the next click resolves.
  const [moreEmailsAvailable, setMoreEmailsAvailable] = useState(false);
  const handledQuery = useRef(false);

  // One-shot toast on ?gmail=connected|error — then strip the query params so
  // a page refresh doesn't fire the toast again.
  useEffect(() => {
    if (handledQuery.current) return;
    const gmail = searchParams.get('gmail');
    if (!gmail) return;
    handledQuery.current = true;

    if (gmail === 'connected') {
      toast.success('Gmail connected successfully.');
    } else if (gmail === 'error') {
      toast.error(messageForReason(searchParams.get('reason')));
    }
    router.replace(pathname);
  }, [searchParams, router, pathname]);

  const kind = classifyStatus(initialStatus);

  const handleConnect = () => {
    startConnect(async () => {
      const result = await getGmailConnectUrlAction();
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      // Top-level nav — cookie's sameSite=lax permits the round-trip back to /callback.
      window.location.href = result.data.url;
    });
  };

  const handleDisconnect = () => {
    if (
      !confirm(
        'Disconnect Gmail? Sync will stop until a Manager reconnects. Historical tickets are preserved.',
      )
    ) {
      return;
    }
    startDisconnect(async () => {
      const result = await disconnectGmailAction();
      if (result.ok) {
        toast.success('Gmail disconnected.');
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });
  };

  const handleBackfill = () => {
    if (
      !confirm(
        'Run backfill? This re-fetches up to 300 emails per click; for long windows you will need to click again. Safe to run multiple times — duplicates are skipped.',
      )
    ) {
      return;
    }
    startBackfill(async () => {
      // Persistent loading toast — dismissed only when the action settles.
      // The button's spinner state already conveys "in flight"; this toast
      // tells the Manager *how long* to wait so they don't refresh away.
      const loadingId = toast.loading(
        'Running backfill — may take up to 60 seconds. Please wait.',
      );
      const result = await runBackfillAction();
      toast.dismiss(loadingId);
      if (!result.ok) {
        setMoreEmailsAvailable(false);
        toast.error(result.error.message);
        return;
      }
      const { complete, emails_fetched, emails_classified } = result.data;
      setMoreEmailsAvailable(!complete);
      toast.success(
        complete
          ? `Recovered ${emails_fetched} email(s) (${emails_classified} classified). All caught up.`
          : `Recovered ${emails_fetched} email(s) (${emails_classified} classified). Click again to fetch more.`,
      );
      router.refresh();
    });
  };

  return (
    <div className="mt-8 space-y-6">
      <GmailSection
        status={initialStatus}
        kind={kind}
        isManager={isManager}
        isConnecting={isConnecting}
        isDisconnecting={isDisconnecting}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
      />
      <BackfillSection
        backfillStatus={initialBackfillStatus}
        gmailConnected={initialStatus.connected}
        isManager={isManager}
        isBackfilling={isBackfilling}
        moreEmailsAvailable={moreEmailsAvailable}
        onBackfill={handleBackfill}
      />
      <PlaceholderSections />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gmail section
// ---------------------------------------------------------------------------

function GmailSection(props: {
  status: GmailStatus;
  kind: StatusKind;
  isManager: boolean;
  isConnecting: boolean;
  isDisconnecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const {
    status,
    kind,
    isManager,
    isConnecting,
    isDisconnecting,
    onConnect,
    onDisconnect,
  } = props;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6">
      <header className="flex items-start justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-md bg-blue-50 flex items-center justify-center">
            <Mail className="h-4.5 w-4.5 text-blue-700" strokeWidth={1.8} />
          </div>
          <div>
            <h2 className="text-[15px] font-semibold text-slate-900">
              Gmail connection
            </h2>
            <p className="text-[12.5px] text-slate-500">
              Shared mailbox used for automated email classification.
            </p>
          </div>
        </div>
        <StatusPill kind={kind} />
      </header>

      <GmailStatusBody status={status} />

      <div className="mt-5 flex items-center gap-2">
        {!isManager ? (
          <p className="text-[12.5px] text-slate-500">
            Only Managers can change the Gmail connection.
          </p>
        ) : kind === 'disconnected' ? (
          <button
            type="button"
            onClick={onConnect}
            disabled={isConnecting}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-[13px] font-medium bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {isConnecting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Connect Gmail
          </button>
        ) : (
          <button
            type="button"
            onClick={onDisconnect}
            disabled={isDisconnecting}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-[13px] font-medium text-red-700 border border-red-200 bg-white hover:bg-red-50 disabled:opacity-50"
          >
            {isDisconnecting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Disconnect
          </button>
        )}
      </div>
    </section>
  );
}

function StatusPill({ kind }: { kind: StatusKind }) {
  const map: Record<
    StatusKind,
    { text: string; cls: string; Icon: typeof CheckCircle2 }
  > = {
    disconnected: {
      text: 'Not connected',
      cls: 'bg-slate-100 text-slate-600 border-slate-200',
      Icon: CircleOff,
    },
    connected: {
      text: 'Connected',
      cls: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      Icon: CheckCircle2,
    },
  };
  const { text, cls, Icon } = map[kind];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11.5px] font-medium ${cls}`}
    >
      <Icon className="h-3 w-3" strokeWidth={2} />
      {text}
    </span>
  );
}

function GmailStatusBody({ status }: { status: GmailStatus }) {
  if (!status.connected) {
    return (
      <p className="text-[13px] text-slate-600">
        No Gmail account is connected. Classification and sync are paused.
      </p>
    );
  }

  const connectedAt = status.connected_at
    ? formatDistanceToNow(new Date(status.connected_at), { addSuffix: true })
    : null;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] text-slate-500">Account:</span>
        <span className="text-[13px] font-medium text-slate-900">
          {status.email}
        </span>
      </div>
      {connectedAt && (
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] text-slate-500">Connected:</span>
          <span className="text-[13px] text-slate-700">{connectedAt}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Backfill section (PR-23)
// ---------------------------------------------------------------------------

function BackfillSection(props: {
  backfillStatus: BackfillStatus | null;
  gmailConnected: boolean;
  isManager: boolean;
  isBackfilling: boolean;
  /** True when the most recent click returned `complete: false`. */
  moreEmailsAvailable: boolean;
  onBackfill: () => void;
}) {
  const {
    backfillStatus,
    gmailConnected,
    isManager,
    isBackfilling,
    moreEmailsAvailable,
    onBackfill,
  } = props;

  if (!backfillStatus) {
    // Server-side action failed (rare — auth was already validated).
    // Hide the section rather than render an empty card.
    return null;
  }

  const lastFullSyncAt = backfillStatus.last_full_sync_at
    ? new Date(backfillStatus.last_full_sync_at)
    : null;
  const lastSyncedAt = backfillStatus.last_synced_at
    ? new Date(backfillStatus.last_synced_at)
    : null;
  const anchor = lastFullSyncAt ?? lastSyncedAt;
  const ageMs = anchor ? Date.now() - anchor.getTime() : null;
  const ageDays = ageMs ? ageMs / (1000 * 60 * 60 * 24) : null;
  const recoverySuggested =
    ageDays !== null && ageDays >= backfillStatus.recovery_threshold_days;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6">
      <header className="flex items-start justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-md bg-amber-50 flex items-center justify-center">
            <History className="h-4.5 w-4.5 text-amber-700" strokeWidth={1.8} />
          </div>
          <div>
            <h2 className="text-[15px] font-semibold text-slate-900">
              Email backfill
            </h2>
            <p className="text-[12.5px] text-slate-500">
              Recover emails missed during an extended sync outage.
            </p>
          </div>
        </div>
        {moreEmailsAvailable ? (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-blue-200 bg-blue-50 text-blue-800 text-[11.5px] font-medium">
            <AlertTriangle className="h-3 w-3" strokeWidth={2} />
            More emails available — click again
          </span>
        ) : recoverySuggested ? (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-amber-800 text-[11.5px] font-medium">
            <AlertTriangle className="h-3 w-3" strokeWidth={2} />
            Recovery suggested
          </span>
        ) : null}
      </header>

      <div className="space-y-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] text-slate-500">Last full sync:</span>
          <span className="text-[13px] font-medium text-slate-900">
            {lastFullSyncAt
              ? `${formatDistanceToNow(lastFullSyncAt, { addSuffix: true })}`
              : 'never'}
          </span>
        </div>
        {backfillStatus.consecutive_failures > 0 && (
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] text-slate-500">
              Consecutive sync failures:
            </span>
            <span className="text-[13px] font-medium text-red-700">
              {backfillStatus.consecutive_failures}
            </span>
          </div>
        )}
      </div>

      <div className="mt-5 flex items-center gap-2">
        {!isManager ? (
          <p className="text-[12.5px] text-slate-500">
            Only Managers can run backfill.
          </p>
        ) : !gmailConnected ? (
          <p className="text-[12.5px] text-slate-500">
            Connect Gmail before running backfill.
          </p>
        ) : !anchor ? (
          <p className="text-[12.5px] text-slate-500">
            No prior sync history — run a manual sync first.
          </p>
        ) : (
          <button
            type="button"
            onClick={onBackfill}
            disabled={isBackfilling}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-[13px] font-medium bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {isBackfilling && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isBackfilling
              ? 'Running backfill…'
              : 'Run backfill (re-click for large windows)'}
          </button>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Placeholder sections (future PRs)
// ---------------------------------------------------------------------------

function PlaceholderSections() {
  return (
    <>
      <PlaceholderCard
        title="Email retention"
        description="Auto-delete processed emails after N days. Default 365 days."
      />
      <PlaceholderCard
        title="Gmail polling"
        description="Enable / disable the 5-minute cron sync."
      />
      <PlaceholderCard
        title="Realtime inbox"
        description="Pub/Sub push notifications for sub-minute latency."
      />
    </>
  );
}

function PlaceholderCard({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-slate-50/60 p-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-[15px] font-semibold text-slate-700">{title}</h2>
          <p className="text-[12.5px] text-slate-500 mt-0.5">{description}</p>
        </div>
        <span className="inline-flex items-center px-2 py-0.5 rounded-full border border-slate-200 bg-white text-[11.5px] font-medium text-slate-500">
          Coming soon
        </span>
      </div>
    </section>
  );
}
