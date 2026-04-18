'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Settings, Users, FileText, Rss } from 'lucide-react';

interface ConfigTab {
  key: string;
  label: string;
  href: string;
  icon: typeof Users;
  disabled?: boolean;
}

const TABS: ConfigTab[] = [
  {
    key: 'team',
    label: 'Team',
    href: '/store-submissions/config/team',
    icon: Users,
  },
  {
    key: 'apps',
    label: 'App Registry',
    href: '/store-submissions/config/apps',
    icon: FileText,
    disabled: true,
  },
  {
    key: 'rules',
    label: 'Email Rules',
    href: '/store-submissions/config/email-rules',
    icon: Rss,
    disabled: true,
  },
  {
    key: 'settings',
    label: 'Settings',
    href: '/store-submissions/config/settings',
    icon: Settings,
    disabled: true,
  },
];

export function ConfigSubNav() {
  const pathname = usePathname();

  return (
    <div className="h-14 bg-white border-b border-slate-200 flex items-center px-8 gap-1 flex-shrink-0">
      {TABS.map((tab) => {
        const active = pathname.startsWith(tab.href);
        const Icon = tab.icon;

        const classes = [
          'inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors',
          active
            ? 'bg-slate-100 text-slate-900'
            : tab.disabled
              ? 'text-slate-300 cursor-not-allowed'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50',
        ].join(' ');

        if (tab.disabled) {
          return (
            <span
              key={tab.key}
              className={classes}
              aria-disabled="true"
              title="Coming soon"
            >
              <Icon className="h-4 w-4" strokeWidth={1.8} />
              {tab.label}
            </span>
          );
        }

        return (
          <Link key={tab.key} href={tab.href} className={classes}>
            <Icon className="h-4 w-4" strokeWidth={1.8} />
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
