'use client';

import { useState, useTransition } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Upload, X, Loader2, CheckCircle2, AlertCircle, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { importAppsCsvAction } from '@/app/(dashboard)/store-submissions/config/apps/actions';

interface CsvImportDialogProps {
  onClose: () => void;
  onSuccess: () => void;
}

type Preview = {
  total_rows: number;
  valid_rows: number;
  error_rows: Array<{
    rowNumber: number;
    raw: Record<string, string>;
    errors: Array<{ path: string; message: string }>;
  }>;
  existing_slugs: string[];
  unknown_owner_emails: string[];
};

type CommitReport = {
  created: Array<{ rowNumber: number; app_id: string; slug: string }>;
  skipped: Array<{ rowNumber: number; slug: string; reason: string }>;
  errors: Array<{ rowNumber: number; slug: string; code: string; message: string }>;
};

type Stage =
  | { kind: 'pick' }
  | { kind: 'preview'; csvText: string; preview: Preview }
  | { kind: 'commit'; report: CommitReport };

const TWO_MB = 2 * 1024 * 1024;

export function CsvImportDialog({ onClose, onSuccess }: CsvImportDialogProps) {
  const [stage, setStage] = useState<Stage>({ kind: 'pick' });
  const [filename, setFilename] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<'SKIP_EXISTING' | 'FAIL_ON_EXISTING'>(
    'SKIP_EXISTING',
  );
  const [isPending, startTransition] = useTransition();

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > TWO_MB) {
      toast.error('CSV must be ≤ 2MB');
      return;
    }
    setFilename(file.name);
    file.text().then((text) => {
      startTransition(async () => {
        const res = await importAppsCsvAction({
          csv_text: text,
          confirm: false,
          strategy,
        });
        if (!res.ok) {
          toast.error(res.error.message);
          setFilename(null);
          return;
        }
        if (res.data.mode !== 'preview') {
          toast.error('Unexpected response from preview step');
          return;
        }
        setStage({
          kind: 'preview',
          csvText: text,
          preview: {
            total_rows: res.data.total_rows,
            valid_rows: res.data.valid_rows,
            error_rows: res.data.error_rows,
            existing_slugs: res.data.existing_slugs,
            unknown_owner_emails: res.data.unknown_owner_emails,
          },
        });
      });
    });
  }

  function handleCommit() {
    if (stage.kind !== 'preview') return;
    const csvText = stage.csvText;
    startTransition(async () => {
      const res = await importAppsCsvAction({
        csv_text: csvText,
        confirm: true,
        strategy,
      });
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      if (res.data.mode !== 'commit') {
        toast.error('Unexpected response from commit step');
        return;
      }
      setStage({
        kind: 'commit',
        report: {
          created: res.data.created,
          skipped: res.data.skipped,
          errors: res.data.errors,
        },
      });
      toast.success(
        `Imported ${res.data.created.length} app${res.data.created.length === 1 ? '' : 's'}`,
      );
    });
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) {
          if (stage.kind === 'commit') onSuccess();
          else onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-slate-900/40 z-40 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white rounded-xl shadow-xl z-50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100 sticky top-0 bg-white z-10">
            <Dialog.Title className="text-[16px] font-semibold text-slate-900">
              Import apps from CSV
            </Dialog.Title>
            <Dialog.Close
              className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600"
              aria-label="Close"
            >
              <X className="h-4 w-4" strokeWidth={1.8} />
            </Dialog.Close>
          </div>

          <div className="px-6 py-5">
            {stage.kind === 'pick' && (
              <PickStep
                isPending={isPending}
                filename={filename}
                strategy={strategy}
                setStrategy={setStrategy}
                onFile={handleFile}
              />
            )}

            {stage.kind === 'preview' && (
              <PreviewStep
                preview={stage.preview}
                isPending={isPending}
                strategy={strategy}
                onBack={() => {
                  setStage({ kind: 'pick' });
                  setFilename(null);
                }}
                onCommit={handleCommit}
              />
            )}

            {stage.kind === 'commit' && (
              <CommitStep report={stage.report} onClose={onSuccess} />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// -- Stage: pick ----------------------------------------------------------

function PickStep({
  isPending,
  filename,
  strategy,
  setStrategy,
  onFile,
}: {
  isPending: boolean;
  filename: string | null;
  strategy: 'SKIP_EXISTING' | 'FAIL_ON_EXISTING';
  setStrategy: (v: 'SKIP_EXISTING' | 'FAIL_ON_EXISTING') => void;
  onFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-slate-600">
        Upload a CSV matching{' '}
        <a
          href="/templates/app-registry-template.csv"
          className="text-[#0071E3] hover:underline"
          download
        >
          templates/app-registry-template.csv
        </a>
        . Columns: <span className="font-mono text-[11.5px]">name, display_name, aliases,
        apple_bundle_id, google_package_name, huawei_app_id, facebook_app_id,
        team_owner_email, active</span>.
      </p>

      <div>
        <label className="block text-[12px] font-medium text-slate-700 mb-1.5">
          Existing slug strategy
        </label>
        <div className="flex gap-2">
          <StrategyOption
            value="SKIP_EXISTING"
            active={strategy === 'SKIP_EXISTING'}
            onSelect={() => setStrategy('SKIP_EXISTING')}
            label="Skip existing"
            hint="Rows with a slug that already exists are reported and ignored."
          />
          <StrategyOption
            value="FAIL_ON_EXISTING"
            active={strategy === 'FAIL_ON_EXISTING'}
            onSelect={() => setStrategy('FAIL_ON_EXISTING')}
            label="Fail on existing"
            hint="Whole import aborts if any slug already exists."
          />
        </div>
      </div>

      <label
        className={`block border-2 border-dashed rounded-xl px-6 py-10 text-center cursor-pointer transition-colors ${
          isPending
            ? 'border-slate-200 bg-slate-50'
            : 'border-slate-300 hover:border-[#0071E3] hover:bg-[#0071E3]/[0.03]'
        }`}
      >
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={onFile}
          disabled={isPending}
          className="sr-only"
        />
        {isPending ? (
          <div className="flex flex-col items-center gap-2 text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-[13px]">Parsing {filename}…</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-slate-500">
            <Upload className="h-6 w-6" strokeWidth={1.6} />
            <span className="text-[13px]">
              <span className="font-medium text-slate-800">Choose a CSV file</span> or drop it here
            </span>
            <span className="text-[11px]">Max 2MB · Max 5000 rows</span>
          </div>
        )}
      </label>
    </div>
  );
}

function StrategyOption({
  value,
  active,
  onSelect,
  label,
  hint,
}: {
  value: string;
  active: boolean;
  onSelect: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex-1 text-left border rounded-lg px-3 py-2.5 transition-colors ${
        active
          ? 'border-[#0071E3] bg-[#0071E3]/[0.04]'
          : 'border-slate-200 hover:border-slate-300'
      }`}
      data-strategy={value}
    >
      <div className="text-[13px] font-medium text-slate-800">{label}</div>
      <div className="text-[11.5px] text-slate-500 mt-0.5">{hint}</div>
    </button>
  );
}

// -- Stage: preview -------------------------------------------------------

function PreviewStep({
  preview,
  isPending,
  strategy,
  onBack,
  onCommit,
}: {
  preview: Preview;
  isPending: boolean;
  strategy: 'SKIP_EXISTING' | 'FAIL_ON_EXISTING';
  onBack: () => void;
  onCommit: () => void;
}) {
  const willCreate = Math.max(0, preview.valid_rows - preview.existing_slugs.length);
  const willSkip = preview.existing_slugs.length;
  const blocking = preview.error_rows.length > 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-2">
        <StatChip label="Total rows" value={preview.total_rows} />
        <StatChip label="Will create" value={willCreate} tone="good" />
        <StatChip label="Will skip" value={willSkip} tone="warn" />
        <StatChip label="Row errors" value={preview.error_rows.length} tone={blocking ? 'bad' : 'muted'} />
      </div>

      {preview.unknown_owner_emails.length > 0 && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-[12px] text-amber-900">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" strokeWidth={1.8} />
          <div>
            <div className="font-semibold mb-0.5">Unknown team owners</div>
            <p>
              These emails aren&apos;t whitelisted in the team — apps will be created
              with owner <span className="font-mono">unassigned</span>:{' '}
              {preview.unknown_owner_emails.map((e) => (
                <code key={e} className="bg-white px-1 py-0.5 rounded border border-amber-200 mx-0.5">
                  {e}
                </code>
              ))}
            </p>
          </div>
        </div>
      )}

      {preview.existing_slugs.length > 0 && (
        <DiffSection
          title="Existing slugs"
          tone="warn"
          items={preview.existing_slugs.map((s) => ({ primary: s, note: strategy === 'FAIL_ON_EXISTING' ? 'Will block the import' : 'Will be skipped' }))}
        />
      )}

      {preview.error_rows.length > 0 && (
        <DiffSection
          title={`Row errors (${preview.error_rows.length})`}
          tone="bad"
          items={preview.error_rows.map((r) => ({
            primary: `Row ${r.rowNumber}`,
            note: r.errors.map((e) => `${e.path}: ${e.message}`).join(' · '),
          }))}
        />
      )}

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onBack}
          disabled={isPending}
          className="px-4 py-2 text-[13px] font-medium text-slate-700 hover:bg-slate-100 rounded-lg disabled:opacity-50"
        >
          Choose different file
        </button>
        <button
          type="button"
          onClick={onCommit}
          disabled={isPending || willCreate === 0 || (blocking && strategy === 'FAIL_ON_EXISTING')}
          className="inline-flex items-center gap-2 bg-[#0071E3] hover:bg-[#005fcc] text-white text-[13px] font-semibold rounded-lg px-4 py-2 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Import {willCreate} app{willCreate === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  );
}

// -- Stage: commit --------------------------------------------------------

function CommitStep({
  report,
  onClose,
}: {
  report: CommitReport;
  onClose: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <StatChip label="Created" value={report.created.length} tone="good" />
        <StatChip label="Skipped" value={report.skipped.length} tone="warn" />
        <StatChip label="Errors" value={report.errors.length} tone={report.errors.length > 0 ? 'bad' : 'muted'} />
      </div>

      {report.created.length > 0 && (
        <DiffSection
          title="Created"
          tone="good"
          items={report.created.map((r) => ({ primary: r.slug, note: `Row ${r.rowNumber}` }))}
        />
      )}

      {report.skipped.length > 0 && (
        <DiffSection
          title="Skipped"
          tone="warn"
          items={report.skipped.map((r) => ({ primary: r.slug, note: `Row ${r.rowNumber} · ${r.reason}` }))}
        />
      )}

      {report.errors.length > 0 && (
        <DiffSection
          title="Errors"
          tone="bad"
          items={report.errors.map((r) => ({ primary: r.slug || `Row ${r.rowNumber}`, note: `${r.code}: ${r.message}` }))}
        />
      )}

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-2 bg-[#0071E3] hover:bg-[#005fcc] text-white text-[13px] font-semibold rounded-lg px-4 py-2 transition-colors"
        >
          <CheckCircle2 className="h-4 w-4" strokeWidth={1.8} />
          Done
        </button>
      </div>
    </div>
  );
}

// -- Shared primitives ----------------------------------------------------

function StatChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'good' | 'warn' | 'bad' | 'muted';
}) {
  const toneClass =
    tone === 'good'
      ? 'text-emerald-700 border-emerald-200 bg-emerald-50'
      : tone === 'warn'
        ? 'text-amber-700 border-amber-200 bg-amber-50'
        : tone === 'bad'
          ? 'text-red-700 border-red-200 bg-red-50'
          : 'text-slate-700 border-slate-200 bg-white';
  return (
    <div className={`border rounded-lg px-3 py-2 ${toneClass}`}>
      <div className="text-[10.5px] uppercase tracking-wider opacity-80">{label}</div>
      <div className="text-[22px] font-semibold leading-none mt-0.5">{value}</div>
    </div>
  );
}

function DiffSection({
  title,
  tone,
  items,
}: {
  title: string;
  tone: 'good' | 'warn' | 'bad';
  items: Array<{ primary: string; note: string }>;
}) {
  const iconClass =
    tone === 'good'
      ? 'text-emerald-600'
      : tone === 'warn'
        ? 'text-amber-600'
        : 'text-red-600';

  const Icon = tone === 'good' ? CheckCircle2 : tone === 'warn' ? FileText : AlertCircle;

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon className={`h-3.5 w-3.5 ${iconClass}`} strokeWidth={1.8} />
        <h4 className="text-[12px] font-semibold uppercase tracking-wider text-slate-600">
          {title}
        </h4>
      </div>
      <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-48 overflow-y-auto">
        {items.map((item, i) => (
          <div
            key={`${item.primary}-${i}`}
            className="px-3 py-1.5 flex items-baseline justify-between gap-3 text-[12px]"
          >
            <span className="font-mono text-slate-800 truncate">{item.primary}</span>
            <span className="text-slate-500 text-[11px] truncate">{item.note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
