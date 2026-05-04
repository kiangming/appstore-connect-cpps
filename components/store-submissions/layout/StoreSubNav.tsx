'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Inbox, BarChart3 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface WorkflowTab {
  key: string;
  label: string;
  href: string;
  icon: LucideIcon;
  /** Active when pathname starts with any of these prefixes. */
  matchPrefixes: string[];
}

const TABS: WorkflowTab[] = [
  {
    key: 'inbox',
    label: 'Inbox',
    href: '/store-submissions/inbox',
    icon: Inbox,
    matchPrefixes: ['/store-submissions/inbox'],
  },
  {
    key: 'reports',
    label: 'Reports',
    href: '/store-submissions/reports/apple',
    icon: BarChart3,
    matchPrefixes: ['/store-submissions/reports'],
  },
];

/**
 * Workflow-level sub-navigation for Store Management. Renders above
 * Inbox + Reports content; hides on Config routes (which have their
 * own ConfigSubNav at the same vertical position).
 */
export function StoreSubNav() {
  const pathname = usePathname();

  // Skip render on Config routes — ConfigSubNav handles that surface.
  if (pathname.startsWith('/store-submissions/config')) return null;

  return (
    <div className="h-14 bg-white border-b border-slate-200 flex items-center px-8 gap-1 flex-shrink-0">
      {TABS.map((tab) => {
        const active = tab.matchPrefixes.some((p) => pathname.startsWith(p));
        const Icon = tab.icon;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            className={[
              'inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors',
              active
                ? 'bg-slate-100 text-slate-900'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50',
            ].join(' ')}
          >
            <Icon className="h-4 w-4" strokeWidth={1.8} />
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
