"use client";

/**
 * Theme toggle button — flips between light and dark explicitly. The default
 * before the user clicks is `system` (handled by ThemeProvider's
 * defaultTheme), so first-time visitors get OS-matched theming for free.
 *
 * The `mounted` guard avoids a hydration mismatch: server doesn't know the
 * client theme, so we render a placeholder until next-themes resolves
 * client-side. Without the guard React warns about ssr/csr divergence on
 * the icon.
 */

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon } from "lucide-react";

interface Props {
  /** "icon" = 40×40 rail button. "row" = full-width labeled row for flyouts. */
  variant: "icon" | "row";
}

export function ThemeToggle({ variant }: Props) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === "dark";
  const next = isDark ? "light" : "dark";
  const Icon = isDark ? Sun : Moon;
  const label = mounted
    ? isDark
      ? "Switch to light mode"
      : "Switch to dark mode"
    : "Toggle theme";

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={() => setTheme(next)}
        title={label}
        aria-label={label}
        className="w-10 h-10 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-colors mb-1"
      >
        {mounted ? (
          <Icon className="h-[20px] w-[20px]" strokeWidth={1.8} />
        ) : (
          <Moon className="h-[20px] w-[20px] opacity-0" strokeWidth={1.8} />
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      className="flex items-center gap-3 h-10 px-4 text-[13px] text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors w-full"
    >
      {mounted ? (
        <Icon className="h-4 w-4 flex-shrink-0" strokeWidth={1.8} />
      ) : (
        <Moon className="h-4 w-4 flex-shrink-0 opacity-0" strokeWidth={1.8} />
      )}
      {mounted ? (isDark ? "Light mode" : "Dark mode") : "Theme"}
    </button>
  );
}
