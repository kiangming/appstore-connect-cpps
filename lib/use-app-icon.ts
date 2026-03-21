"use client";

import { useEffect, useState } from "react";

export const AVATAR_COLORS = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-rose-500",
  "bg-amber-500",
  "bg-cyan-500",
  "bg-indigo-500",
  "bg-pink-500",
];

export function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function getInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function useAppIcon(bundleId: string | null): string | null {
  const [iconUrl, setIconUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!bundleId) return;
    fetch(
      `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}&country=vn`
    )
      .then((r) => r.json())
      .then((data) => setIconUrl(data.results?.[0]?.artworkUrl512 ?? null))
      .catch(() => {});
  }, [bundleId]);

  return iconUrl;
}
