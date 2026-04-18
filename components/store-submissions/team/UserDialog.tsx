'use client';

import { useTransition } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { TeamUser } from '@/lib/store-submissions/queries/users';
import {
  createUser,
  updateUser,
} from '@/app/(dashboard)/store-submissions/config/team/actions';
import {
  createUserSchema,
  editUserFormSchema,
  storeRoleSchema,
  storeUserStatusSchema,
  type CreateUserInput,
  type EditUserFormInput,
  type UpdateUserInput,
} from '@/lib/store-submissions/schemas/user';

export type UserDialogMode = 'create' | 'edit';

interface UserDialogProps {
  mode: UserDialogMode;
  user?: TeamUser;
  activeManagerCount: number;
  onClose: () => void;
  onSuccess: () => void;
}

export function UserDialog({
  mode,
  user,
  activeManagerCount,
  onClose,
  onSuccess,
}: UserDialogProps) {
  if (mode === 'edit' && !user) {
    throw new Error('UserDialog: user is required in edit mode');
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-slate-900/40 z-40 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white rounded-xl shadow-xl z-50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100">
            <Dialog.Title className="text-[16px] font-semibold text-slate-900">
              {mode === 'create' ? 'Add team member' : 'Edit team member'}
            </Dialog.Title>
            <Dialog.Close
              className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600"
              aria-label="Close"
            >
              <X className="h-4 w-4" strokeWidth={1.8} />
            </Dialog.Close>
          </div>
          {mode === 'create' ? (
            <CreateForm onSuccess={onSuccess} onCancel={onClose} />
          ) : (
            <EditForm
              user={user!}
              activeManagerCount={activeManagerCount}
              onSuccess={onSuccess}
              onCancel={onClose}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ============================================================
// Create form
// ============================================================

function CreateForm({
  onSuccess,
  onCancel,
}: {
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateUserInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(createUserSchema) as any,
    defaultValues: { email: '', role: 'DEV', display_name: '' },
  });

  const onSubmit = (data: CreateUserInput) => {
    startTransition(async () => {
      const result = await createUser(data);
      if (result.ok) {
        toast.success(`${data.email} added.`);
        onSuccess();
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="px-6 py-5 space-y-4">
      <Field label="Email" error={errors.email?.message}>
        <input
          type="email"
          autoFocus
          placeholder="name@company.com"
          {...register('email')}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[14px] focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
        />
      </Field>

      <Field label="Role" error={errors.role?.message}>
        <select
          {...register('role')}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[14px] bg-white focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
        >
          {storeRoleSchema.options.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Display name (optional)" error={errors.display_name?.message}>
        <input
          type="text"
          placeholder="e.g. Alice Nguyen"
          {...register('display_name')}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[14px] focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
        />
      </Field>

      <DialogFooter isPending={isPending} label="Add member" onCancel={onCancel} />
    </form>
  );
}

// ============================================================
// Edit form
// ============================================================

function EditForm({
  user,
  activeManagerCount,
  onSuccess,
  onCancel,
}: {
  user: TeamUser;
  activeManagerCount: number;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
  } = useForm<EditUserFormInput>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(editUserFormSchema) as any,
    defaultValues: {
      id: user.id,
      role: user.role,
      status: user.status,
      display_name: user.display_name ?? '',
    },
  });

  const watchedRole = watch('role');
  const watchedStatus = watch('status');
  const isLastActiveManager =
    user.role === 'MANAGER' &&
    user.status === 'active' &&
    activeManagerCount <= 1;
  const wouldBreakInvariant =
    isLastActiveManager &&
    (watchedRole !== 'MANAGER' || watchedStatus !== 'active');

  const onSubmit = (data: EditUserFormInput) => {
    if (wouldBreakInvariant) {
      toast.error('Cannot change role/status — you are the last active MANAGER.');
      return;
    }
    startTransition(async () => {
      const currentDisplayName = user.display_name ?? '';
      const nextDisplayName = data.display_name ?? '';
      const payload: UpdateUserInput = {
        id: data.id,
        role: data.role !== user.role ? data.role : undefined,
        status: data.status !== user.status ? data.status : undefined,
        display_name:
          nextDisplayName !== currentDisplayName
            ? data.display_name
            : undefined,
      };
      const result = await updateUser(payload);
      if (result.ok) {
        toast.success('Member updated.');
        onSuccess();
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="px-6 py-5 space-y-4">
      <input type="hidden" {...register('id')} />

      <Field label="Email">
        <input
          type="email"
          disabled
          value={user.email}
          className="w-full px-3 py-2 border border-slate-200 bg-slate-50 rounded-lg text-[14px] text-slate-500"
        />
      </Field>

      <Field label="Role" error={errors.role?.message}>
        <select
          {...register('role')}
          disabled={isLastActiveManager}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[14px] bg-white disabled:bg-slate-50 disabled:text-slate-500 focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
        >
          {storeRoleSchema.options.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Status" error={errors.status?.message}>
        <select
          {...register('status')}
          disabled={isLastActiveManager}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[14px] bg-white disabled:bg-slate-50 disabled:text-slate-500 focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
        >
          {storeUserStatusSchema.options.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Display name" error={errors.display_name?.message}>
        <input
          type="text"
          {...register('display_name')}
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-[14px] focus:outline-none focus:ring-2 focus:ring-[#0071E3]/20 focus:border-[#0071E3]"
        />
      </Field>

      {isLastActiveManager && (
        <p className="text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          This is the last active MANAGER. Role and status are locked until
          another MANAGER is added.
        </p>
      )}

      <DialogFooter isPending={isPending} label="Save changes" onCancel={onCancel} />
    </form>
  );
}

// ============================================================
// Shared form primitives
// ============================================================

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[12px] font-medium text-slate-700 mb-1.5">
        {label}
      </label>
      {children}
      {error && (
        <p className="text-[12px] text-red-600 mt-1">{error}</p>
      )}
    </div>
  );
}

function DialogFooter({
  isPending,
  label,
  onCancel,
}: {
  isPending: boolean;
  label: string;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2 pt-2">
      <button
        type="button"
        onClick={onCancel}
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
        {label}
      </button>
    </div>
  );
}
