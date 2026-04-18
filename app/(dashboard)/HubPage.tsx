"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { Layers, Inbox, ArrowRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface ToolCard {
  id: string;
  name: string;
  description: string;
  icon: LucideIcon;
  href: string;
}

const TOOLS: ToolCard[] = [
  {
    id: "cpp-manager",
    name: "CPP Manager",
    description: "Manage App Store Custom Product Pages",
    icon: Layers,
    href: "/apps",
  },
  {
    id: "store-submissions",
    name: "Store Management",
    description: "Track app submission status across stores from email",
    icon: Inbox,
    href: "/store-submissions",
  },
];

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function HubPage() {
  const { data: session } = useSession();
  const displayName = session?.user?.name?.split(" ")[0] ?? "";

  return (
    <div className="flex-1 flex items-start justify-center pt-[12vh] px-6">
      <div className="w-full max-w-xl">
        {/* Greeting */}
        <h1 className="text-[28px] font-semibold text-slate-900 tracking-tight">
          {getGreeting()}
          {displayName ? `, ${displayName}` : ""}
        </h1>
        <p className="text-[15px] text-slate-500 mt-1 mb-8">
          Internal Tools
        </p>

        {/* Tool grid */}
        <div className="grid grid-cols-2 gap-4">
          {TOOLS.map((tool) => (
            <Link
              key={tool.id}
              href={tool.href}
              className="group bg-white rounded-2xl border border-slate-200 p-6 transition-all duration-150 hover:border-[#0071E3] hover:shadow-sm"
            >
              <tool.icon
                className="h-8 w-8 text-[#0071E3] mb-4"
                strokeWidth={1.5}
              />
              <h2 className="text-[17px] font-semibold text-slate-900 mb-1">
                {tool.name}
              </h2>
              <p className="text-[13px] text-slate-500 leading-relaxed mb-4">
                {tool.description}
              </p>
              <span className="inline-flex items-center gap-1 text-[12px] text-[#0071E3] font-medium opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                Open
                <ArrowRight className="h-3 w-3" />
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
