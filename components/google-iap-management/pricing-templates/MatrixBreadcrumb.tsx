import Link from "next/link";
import { ChevronRight } from "lucide-react";

export interface MatrixBreadcrumbProps {
  trail: Array<{ label: string; href?: string }>;
}

export function MatrixBreadcrumb({ trail }: MatrixBreadcrumbProps) {
  return (
    <nav className="flex items-center text-xs text-slate-500 mb-3" aria-label="Breadcrumb">
      {trail.map((seg, i) => {
        const isLast = i === trail.length - 1;
        return (
          <span key={i} className="flex items-center">
            {i > 0 && <ChevronRight className="h-3 w-3 mx-1 text-slate-300" />}
            {isLast || !seg.href ? (
              <span className={isLast ? "text-slate-700 font-medium" : "text-slate-500"}>
                {seg.label}
              </span>
            ) : (
              <Link href={seg.href} className="hover:text-slate-700 transition">
                {seg.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
