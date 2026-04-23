'use client';

import { useMemo, useState, useTransition } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2, X, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import type { AppListRow } from '@/lib/store-submissions/queries/apps';
import type { TeamUser } from '@/lib/store-submissions/queries/users';
import type { PlatformKey } from '@/lib/store-submissions/schemas/app';
import {
  createAppAction,
  renameAppAction,
  removePlatformBindingAction,
  setPlatformBindingAction,
  updateAppAction,
} from '@/app/(dashboard)/store-submissions/config/apps/actions';
import { generateSlugFromName } from '@/lib/store-submissions/apps/alias-logic';
import {
  PLATFORM_KEYS,
  buildCreatePayload,
  buildEditActionPlan,
  validateFormState,
  type FormState,
} from './app-dialog-logic';

export type AppDialogMode = 'create' | 'edit';

interface AppDialogProps {
  mode: AppDialogMode;
  app?: AppListRow;
  teamUsers: TeamUser[];
  onClose: () => void;
  onSuccess: () => void;
}

const PLATFORM_LABELS: Record<PlatformKey, string> = {
  apple: 'Apple App Store',
  google: 'Google Play',
  huawei: 'Huawei AppGallery',
  facebook: 'Facebook',
};

const PLATFORM_REF_HINT: Record<PlatformKey, string> = {
  apple: 'Bundle ID, e.g. com.studio.skyline',
  google: 'Package name, e.g. com.studio.skyline',
  huawei: 'AppGallery app ID',
  facebook: 'Facebook app ID',
};

function emptyBindings(): FormState['bindings'] {
  return {
    apple: { enabled: false, platform_ref: '', console_url: '' },
    google: { enabled: false, platform_ref: '', console_url: '' },
    huawei: { enabled: false, platform_ref: '', console_url: '' },
    facebook: { enabled: false, platform_ref: '', console_url: '' },
  };
}

function bindingsFromApp(app: AppListRow): FormState['bindings'] {
  const result = emptyBindings();
  for (const b of app.bindings) {
    result[b.platform_key] = {
      enabled: true,
      platform_ref: b.platform_ref ?? '',
      console_url: b.console_url ?? '',
    };
  }
  return result;
}

function defaultsFromApp(app: AppListRow): FormState {
  return {
    name: app.name,
    display_name: app.display_name ?? '',
    team_owner_id: app.team_owner_id ?? '',
    active: app.active,
    bindings: bindingsFromApp(app),
  };
}

function defaultsForCreate(): FormState {
  return {
    name: '',
    display_name: '',
    team_owner_id: '',
    active: true,
    bindings: emptyBindings(),
  };
}

export function AppDialog({ mode, app, teamUsers, onClose, onSuccess }: AppDialogProps) {
  if (mode === 'edit' && !app) {
    throw new Error('AppDialog: app is required in edit mode');
  }

  const [form, setForm] = useState<FormState>(() =>
    mode === 'edit' && app ? defaultsFromApp(app) : defaultsForCreate(),
  );
  const [isPending, startTransition] = useTransition();

  const slugPreview = useMemo(() => {
    if (form.name.trim() === '') return '—';
    try {
      return generateSlugFromName(form.name);
    } catch {
      return '(name produces no valid slug)';
    }
  }, [form.name]);

  const nameChanged = mode === 'edit' && app && form.name.trim() !== app.name;

  function updateBinding(
    key: PlatformKey,
    field: 'platform_ref' | 'console_url',
    value: string,
  ) {
    setForm((prev) => ({
      ...prev,
      bindings: { ...prev.bindings, [key]: { ...prev.bindings[key], [field]: value } },
    }));
  }

  function togglePlatform(key: PlatformKey, enabled: boolean) {
    setForm((prev) => ({
      ...prev,
      bindings: { ...prev.bindings, [key]: { ...prev.bindings[key], enabled } },
    }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validation = validateFormState(form);
    if (!validation.ok) {
      toast.error(validation.error);
      return;
    }

    startTransition(async () => {
      if (mode === 'create') {
        const result = await createAppAction(buildCreatePayload(form));
        if (result.ok) {
          toast.success(`Added "${form.name.trim()}" (slug: ${result.data.slug})`);
          onSuccess();
        } else {
          toast.error(result.error.message);
        }
        return;
      }

      // Edit mode: dispatch pure action plan so partial failure surfaces clearly.
      const original = app!;
      const plan = buildEditActionPlan(form, original);
      const failures: string[] = [];

      for (const action of plan) {
        switch (action.kind) {
          case 'rename': {
            const res = await renameAppAction({
              id: original.id,
              new_name: action.new_name,
            });
            if (!res.ok) failures.push(`rename: ${res.error.message}`);
            break;
          }
          case 'update': {
            const res = await updateAppAction({ id: original.id, ...action.patch });
            if (!res.ok) failures.push(`update: ${res.error.message}`);
            break;
          }
          case 'upsertBinding': {
            const res = await setPlatformBindingAction({
              app_id: original.id,
              platform: action.platform,
              platform_ref: action.platform_ref,
              console_url: action.console_url,
            });
            if (!res.ok) failures.push(`${action.platform}: ${res.error.message}`);
            break;
          }
          case 'removeBinding': {
            const res = await removePlatformBindingAction({
              app_id: original.id,
              platform: action.platform,
            });
            if (!res.ok) failures.push(`${action.platform}: ${res.error.message}`);
            break;
          }
        }
      }

      if (failures.length > 0) {
        toast.error(`Some changes failed: ${failures.join('; ')}`);
        return;
      }
      toast.success(`Saved changes to "${form.name.trim()}"`);
      onSuccess();
    });
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-slate-900/40 z-40 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white rounded-xl shadow-xl z-50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100 sticky top-0 bg-white z-10">
            <Dialog.Title className="text-[16px] font-semibold text-slate-900">
              {mode === 'create' ? 'Add app' : `Edit app — ${app!.name}`}
            </Dialog.Title>
            <Dialog.Close
              className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600"
              aria-label="Close"
            >
              <X className="h-4 w-4" strokeWidth={1.8} />
            </Dialog.Close>
          </div>

          <form onSubmit={handleSubmit} className="px-6 py-5 space-y-6">
            <section className="space-y-4">
              <SectionHeader title="Info" />

              <Field label="Name" required>
                <input
                  type="text"
                  autoFocus
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. Skyline Runners"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[14px] focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  {mode === 'create' ? (
                    <>Slug preview: <span className="font-mono">{slugPreview}</span></>
                  ) : (
                    <>Current slug: <span className="font-mono">{app!.slug}</span> (won&apos;t change on rename)</>
                  )}
                </p>
              </Field>

              {nameChanged && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-[12px] text-amber-900">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" strokeWidth={1.8} />
                  <div>
                    <div className="font-semibold mb-0.5">Renaming this app</div>
                    <p>
                      The old name <span className="font-mono">{app!.name}</span> will be kept
                      as an alias with the <span className="font-mono uppercase tracking-wider">prev</span> badge,
                      so emails still referencing the old name continue to classify correctly.
                    </p>
                  </div>
                </div>
              )}

              <Field label="Display name (optional)">
                <input
                  type="text"
                  value={form.display_name}
                  onChange={(e) => setForm((p) => ({ ...p, display_name: e.target.value }))}
                  placeholder="Long marketing name, defaults to Name"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[14px] focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
                />
              </Field>

              <div className="grid grid-cols-2 gap-4">
                <Field label="Team owner">
                  <select
                    value={form.team_owner_id}
                    onChange={(e) => setForm((p) => ({ ...p, team_owner_id: e.target.value }))}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[14px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
                  >
                    <option value="">Unassigned</option>
                    {teamUsers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.display_name ?? u.email}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Status">
                  <label className="inline-flex items-center gap-2 h-[38px] text-[13px] text-slate-700">
                    <input
                      type="checkbox"
                      checked={form.active}
                      onChange={(e) => setForm((p) => ({ ...p, active: e.target.checked }))}
                      className="h-4 w-4 rounded border-slate-300 text-[#0071E3] focus:ring-[#0071E3]/20"
                    />
                    Active (receives email classification)
                  </label>
                </Field>
              </div>
            </section>

            <section className="space-y-3">
              <SectionHeader
                title="Platform bindings"
                hint="Check at least one platform — ref can be filled later"
              />
              <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                {PLATFORM_KEYS.map((key) => {
                  const enabled = form.bindings[key].enabled;
                  return (
                    <label
                      key={key}
                      className="px-3 py-3 grid grid-cols-[auto_140px_1fr_1fr] gap-3 items-center cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => togglePlatform(key, e.target.checked)}
                        className="h-4 w-4 rounded border-slate-300 text-[#0071E3] focus:ring-[#0071E3]/20"
                      />
                      <div
                        className={`text-[12.5px] ${enabled ? 'text-slate-700' : 'text-slate-400'}`}
                      >
                        {PLATFORM_LABELS[key]}
                      </div>
                      <input
                        type="text"
                        value={form.bindings[key].platform_ref}
                        onChange={(e) => updateBinding(key, 'platform_ref', e.target.value)}
                        placeholder={PLATFORM_REF_HINT[key]}
                        disabled={!enabled}
                        className="px-2.5 py-1.5 border border-slate-200 rounded-md text-[12.5px] font-mono focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed"
                      />
                      <input
                        type="url"
                        value={form.bindings[key].console_url}
                        onChange={(e) => updateBinding(key, 'console_url', e.target.value)}
                        placeholder="Console URL (optional)"
                        disabled={!enabled}
                        className="px-2.5 py-1.5 border border-slate-200 rounded-md text-[12.5px] focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3] disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed"
                      />
                    </label>
                  );
                })}
              </div>
              <p className="text-[11px] text-slate-400">
                Aliases are managed from the app row&apos;s expanded view after create.
              </p>
            </section>

            <div className="flex items-center justify-end gap-2 pt-2 sticky bottom-0 bg-white -mx-6 px-6 py-3 border-t border-slate-100">
              <button
                type="button"
                onClick={onClose}
                disabled={isPending}
                className="px-4 py-2 text-[13px] font-medium text-slate-700 hover:bg-slate-100 rounded-lg disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isPending}
                className="inline-flex items-center gap-2 bg-[#0071E3] hover:bg-[#005fcc] text-white text-[13px] font-semibold rounded-lg px-4 py-2 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {mode === 'create' ? 'Add app' : 'Save changes'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// -- Shared primitives -----------------------------------------------------

function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <h3 className="text-[13px] font-semibold uppercase tracking-wider text-slate-500">
        {title}
      </h3>
      {hint && <span className="text-[11px] text-slate-400">{hint}</span>}
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[12px] font-medium text-slate-700 mb-1.5">
        {label}
        {required && <span className="text-red-600 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}
