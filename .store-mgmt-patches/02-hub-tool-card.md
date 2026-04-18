# Patch: Hub page — thêm tool card cho Store Management

**File**: `app/(dashboard)/page.tsx`

## Change

Thêm 1 tool card thứ 2 vào grid.

### Before

```tsx
import { Layers } from "lucide-react";
import Link from "next/link";

export default function HubPage() {
  return (
    <main className="bg-slate-50 min-h-screen">
      <div className="max-w-xl mx-auto py-16 px-6">
        <h1 className="text-2xl font-semibold text-slate-900">Good morning</h1>
        <p className="text-slate-500 text-sm mb-8">Internal Tools</p>

        <div className="grid grid-cols-2 gap-4">
          {/* CPP Manager card */}
          <Link
            href="/apps"
            className="group bg-white rounded-2xl border border-slate-200 p-6
                       hover:border-[#0071E3] hover:shadow-sm transition-all duration-150"
          >
            <Layers className="w-8 h-8 text-[#0071E3] mb-4" />
            <h2 className="font-semibold text-[17px] text-slate-900">CPP Manager</h2>
            <p className="text-[13px] text-slate-500 mt-1">
              Manage App Store Custom Product Pages
            </p>
            <div className="mt-4 text-[12px] text-[#0071E3] opacity-0 group-hover:opacity-100 transition">
              → Open
            </div>
          </Link>
        </div>
      </div>
    </main>
  );
}
```

### After

```tsx
import { Layers, Inbox } from "lucide-react";
import Link from "next/link";

const TOOLS = [
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

export default function HubPage() {
  return (
    <main className="bg-slate-50 min-h-screen">
      <div className="max-w-xl mx-auto py-16 px-6">
        <h1 className="text-2xl font-semibold text-slate-900">Good morning</h1>
        <p className="text-slate-500 text-sm mb-8">Internal Tools</p>

        <div className="grid grid-cols-2 gap-4">
          {TOOLS.map((tool) => {
            const Icon = tool.icon;
            return (
              <Link
                key={tool.id}
                href={tool.href}
                className="group bg-white rounded-2xl border border-slate-200 p-6
                           hover:border-[#0071E3] hover:shadow-sm transition-all duration-150"
              >
                <Icon className="w-8 h-8 text-[#0071E3] mb-4" />
                <h2 className="font-semibold text-[17px] text-slate-900">
                  {tool.name}
                </h2>
                <p className="text-[13px] text-slate-500 mt-1">
                  {tool.description}
                </p>
                <div className="mt-4 text-[12px] text-[#0071E3] opacity-0 group-hover:opacity-100 transition">
                  → Open
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </main>
  );
}
```

## Notes

- Refactor thành `TOOLS` array cho dễ extend khi có tool 3, 4, ...
- Grid `grid-cols-2` giữ nguyên — sẽ wrap tự nhiên khi có 3-4+ tools
- Greeting "Good morning" nên dynamic theo giờ: có thể thêm helper `getGreeting(date)` → "Good morning/afternoon/evening". Defer để sau.
- Nếu muốn personalize "Good morning, Minh" như mockup: fetch `session.user.name` từ NextAuth

## Verify

Sau khi patch:
```bash
pnpm dev
```

Navigate tới `/` sau login:
- Thấy 2 tool cards side-by-side
- Hover card → border xanh Apple, "→ Open" hiện ra
- Click Store card → navigate `/store-submissions`
