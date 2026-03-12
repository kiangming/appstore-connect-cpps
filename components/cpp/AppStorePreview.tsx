"use client";

import Image from "next/image";

interface Props {
  screenshots: string[];
  appName: string;
}

export function AppStorePreview({ screenshots, appName }: Props) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6">
      <h2 className="text-sm font-medium text-slate-700 mb-4">App Store Preview</h2>

      {/* iPhone frame mockup */}
      <div className="flex justify-center">
        <div className="relative w-[320px]">
          {/* Phone outline */}
          <div className="rounded-[40px] border-[10px] border-slate-800 bg-black overflow-hidden shadow-2xl">
            {/* Status bar */}
            <div className="bg-slate-900 h-6 flex items-center justify-between px-4">
              <span className="text-white text-[9px] font-medium">9:41</span>
              <div className="flex gap-1 items-center">
                <div className="w-3 h-2 border border-white/70 rounded-[2px]">
                  <div className="h-full w-3/4 bg-white/70 rounded-[1px]" />
                </div>
              </div>
            </div>

            {/* App Store chrome */}
            <div className="bg-white px-3 py-2 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-slate-900 truncate">{appName}</p>
                  <p className="text-[10px] text-slate-500">App</p>
                </div>
                <button className="bg-[#0071E3] text-white text-[10px] font-semibold px-3 py-1 rounded-full">
                  GET
                </button>
              </div>
            </div>

            {/* Screenshot carousel */}
            <div className="bg-slate-100 min-h-[480px] overflow-x-auto">
              {screenshots.length > 0 ? (
                <div className="flex gap-2 p-2 h-full">
                  {screenshots.map((src, i) => (
                    <div
                      key={i}
                      className="flex-shrink-0 w-[280px] rounded-xl overflow-hidden bg-white"
                    >
                      <Image
                        src={src}
                        alt={`Screenshot ${i + 1}`}
                        width={280}
                        height={480}
                        className="object-cover w-full h-full"
                        unoptimized
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center justify-center h-[480px]">
                  <div className="text-center">
                    <div className="w-16 h-16 rounded-2xl bg-slate-200 mx-auto mb-3" />
                    <p className="text-xs text-slate-400">Upload screenshots to preview</p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Home indicator */}
          <div className="flex justify-center mt-2">
            <div className="w-24 h-1 bg-slate-800 rounded-full" />
          </div>
        </div>
      </div>

      {screenshots.length > 0 && (
        <p className="text-center text-xs text-slate-400 mt-4">
          {screenshots.length} screenshot{screenshots.length !== 1 ? "s" : ""}
        </p>
      )}
    </div>
  );
}
