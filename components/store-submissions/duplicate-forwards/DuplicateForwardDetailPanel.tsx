import Link from 'next/link';

import type {
  DuplicateForwardDetailPair,
  DuplicateForwardEmail,
} from '@/lib/store-submissions/queries/duplicate-forwards';

interface Props {
  pair: DuplicateForwardDetailPair | null;
  appNameById: Map<string, string>;
}

/**
 * Side-by-side detail pane: duplicate (left) vs original (right).
 * Renders only when a row is selected via `?selected=<id>`. Empty
 * state prompts the Manager to click a row.
 *
 * The two columns share a vertical grid of labeled fields so
 * differences (sender, received_at) and matches (subject,
 * submission_id, fingerprint) are easy to scan. Body excerpts are
 * collapsed to ~500 chars by Apple-template convention (matches the
 * email_snapshot field in ticket_entries).
 */
export function DuplicateForwardDetailPanel({
  pair,
  appNameById,
}: Props) {
  if (!pair) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-8 text-center">
        <div className="text-[13.5px] font-medium text-slate-700">
          Click a row to view detail
        </div>
        <div className="text-[12px] text-slate-500 mt-1">
          The selected duplicate will display here alongside its original.
        </div>
      </div>
    );
  }

  const { duplicate, original } = pair;

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
        <div>
          <div className="text-[13.5px] font-semibold text-slate-900">
            Forwarded duplicate detail
          </div>
          <div className="text-[11.5px] text-slate-500">
            Fingerprint match within ±5 min window
          </div>
        </div>
        {original?.ticket_id ? (
          <Link
            href={`/store-submissions/inbox?ticket=${original.ticket_id}`}
            className="text-[#0071E3] text-[12.5px] hover:underline"
          >
            View original ticket →
          </Link>
        ) : null}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-200">
        <EmailColumn
          label="Duplicate (forwarded copy)"
          email={duplicate}
          appNameById={appNameById}
          tone="rose"
        />
        {original ? (
          <EmailColumn
            label="Original (first received)"
            email={original}
            appNameById={appNameById}
            tone="emerald"
          />
        ) : (
          <div className="p-4">
            <div className="text-[12.5px] font-medium text-slate-500 mb-2">
              Original (first received)
            </div>
            <div className="text-[12px] text-slate-400 italic">
              Original email is no longer available — it may have been purged
              by the cleanup cron. The duplicate row&apos;s
              <code className="px-1">duplicate_fingerprint</code> remains as
              audit signal.
            </div>
          </div>
        )}
      </div>

      <div className="px-4 py-3 border-t border-slate-200 bg-slate-50 text-[11.5px] text-slate-500 font-mono break-all">
        <span className="text-slate-700 font-medium">Fingerprint:</span>{' '}
        {duplicate.duplicate_fingerprint ?? '(none)'}
      </div>
    </div>
  );
}

interface EmailColumnProps {
  label: string;
  email: DuplicateForwardEmail;
  appNameById: Map<string, string>;
  tone: 'rose' | 'emerald';
}

function EmailColumn({
  label,
  email,
  appNameById,
  tone,
}: EmailColumnProps) {
  const accent =
    tone === 'rose'
      ? 'bg-rose-50 text-rose-700 ring-rose-200'
      : 'bg-emerald-50 text-emerald-700 ring-emerald-200';

  const ext = (email.extracted_payload ?? {}) as Record<string, unknown>;
  const clf = (email.classification_result ?? {}) as Record<string, unknown>;
  const appId = readString(clf, 'app_id');
  const submissionId = readString(ext, 'submission_id');
  const outcome = readString(clf, 'outcome');
  const bodyExcerpt = (email.raw_body_text ?? '').slice(0, 500);

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ring-1 ${accent}`}
        >
          {label}
        </span>
      </div>

      <Field label="Email ID" value={email.id} mono />
      <Field
        label="Received"
        value={new Date(email.received_at).toLocaleString('en-GB', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })}
      />
      <Field
        label="Sender"
        value={
          email.sender_name
            ? `${email.sender_name} <${email.sender_email}>`
            : email.sender_email
        }
      />
      <Field label="Subject" value={email.subject} />
      <Field
        label="App"
        value={
          appId
            ? appNameById.get(appId) ?? `(unknown: ${appId.slice(0, 8)}…)`
            : null
        }
      />
      <Field label="Outcome" value={outcome} />
      <Field label="Submission ID" value={submissionId} mono />
      {email.ticket_id ? (
        <Field
          label="Attached ticket"
          value={
            <Link
              href={`/store-submissions/inbox?ticket=${email.ticket_id}`}
              className="text-[#0071E3] hover:underline"
            >
              {email.ticket_id.slice(0, 8)}…
            </Link>
          }
        />
      ) : (
        <Field label="Attached ticket" value="(none — wire skipped)" />
      )}

      <div>
        <div className="text-[11.5px] uppercase tracking-wide text-slate-500 font-medium mb-1">
          Body excerpt
        </div>
        <pre className="text-[11.5px] text-slate-700 whitespace-pre-wrap font-sans bg-slate-50 rounded-md p-2 max-h-48 overflow-auto">
          {bodyExcerpt || (
            <span className="italic text-slate-400">(no body persisted)</span>
          )}
        </pre>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500 font-medium">
        {label}
      </div>
      <div
        className={
          mono
            ? 'text-[11.5px] text-slate-700 font-mono break-all mt-0.5'
            : 'text-[12.5px] text-slate-700 break-words mt-0.5'
        }
      >
        {value || <span className="text-slate-400 italic">—</span>}
      </div>
    </div>
  );
}

function readString(
  obj: Record<string, unknown>,
  key: string,
): string | null {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
