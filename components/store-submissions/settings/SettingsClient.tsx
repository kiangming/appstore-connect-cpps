'use client';

import { useEffect, useRef, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import {
  AlertCircle,
  CheckCircle2,
  CircleOff,
  Clock,
  Loader2,
  Mail,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  disconnectGmailAction,
  getGmailConnectUrlAction,
  type GmailStatus,
} from '@/app/(dashboard)/store-submissions/config/settings/actions';
import {
  classifyStatus,
  messageForReason,
  type GmailStatusKind,
} from './helpers';

interface SettingsClientProps {
  initialStatus: GmailStatus;
  isManager: boolean;
}

type StatusKind = GmailStatusKind;

export function SettingsClient({ initialStatus, isManager }: SettingsClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isConnecting, startConnect] = useTransition();
  const [isDisconnecting, startDisconnect] = useTransition();
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

      <GmailStatusBody status={status} kind={kind} />

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
          <>
            {(kind === 'expiring' || kind === 'expired') && (
              <button
                type="button"
                onClick={onConnect}
                disabled={isConnecting}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-[13px] font-medium bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {isConnecting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Reconnect
              </button>
            )}
            <button
              type="button"
              onClick={onDisconnect}
              disabled={isDisconnecting}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-[13px] font-medium text-red-700 border border-red-200 bg-white hover:bg-red-50 disabled:opacity-50"
            >
              {isDisconnecting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Disconnect
            </button>
          </>
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
    healthy: {
      text: 'Connected',
      cls: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      Icon: CheckCircle2,
    },
    expiring: {
      text: 'Expiring soon',
      cls: 'bg-amber-50 text-amber-700 border-amber-200',
      Icon: Clock,
    },
    expired: {
      text: 'Expired',
      cls: 'bg-red-50 text-red-700 border-red-200',
      Icon: AlertCircle,
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

function GmailStatusBody({
  status,
  kind,
}: {
  status: GmailStatus;
  kind: StatusKind;
}) {
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
      {kind === 'expiring' &&
        typeof status.expiry_days === 'number' &&
        status.expiry_days >= 0 && (
          <p className="mt-2 text-[12.5px] text-amber-700">
            Token expires in {status.expiry_days}{' '}
            {status.expiry_days === 1 ? 'day' : 'days'}. Reconnect before it
            expires to avoid sync interruption.
          </p>
        )}
      {kind === 'expired' && (
        <p className="mt-2 text-[12.5px] text-red-700">
          Token expired. Gmail sync is stopped — reconnect to resume
          classification.
        </p>
      )}
    </div>
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
