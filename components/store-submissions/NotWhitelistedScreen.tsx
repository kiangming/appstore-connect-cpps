import { Inbox, ShieldX } from 'lucide-react';
import Link from 'next/link';

export function NotWhitelistedScreen({ email }: { email: string }) {
  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mb-4">
          <ShieldX className="h-6 w-6 text-red-500" strokeWidth={1.8} />
        </div>
        <h1 className="text-xl font-semibold text-slate-900 mb-2">
          Access denied
        </h1>
        <p className="text-[14px] text-slate-600 leading-relaxed mb-1">
          Email <span className="font-medium text-slate-900">{email}</span> is not
          whitelisted in Store Management.
        </p>
        <p className="text-[13px] text-slate-500 mb-8">
          Contact a Manager to request access.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-[13px] text-[#0071E3] hover:underline"
        >
          <Inbox className="h-4 w-4" strokeWidth={1.8} />
          Back to hub
        </Link>
      </div>
    </div>
  );
}
