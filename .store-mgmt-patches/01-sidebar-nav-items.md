# Patch: AppSidebar — thêm nav item cho Store Management

**File**: `components/layout/AppSidebar.tsx`

## Change

Trong `NAV_ITEMS` array, thêm entry cho Store Management.

### Before
```typescript
import { Layers } from "lucide-react";

const NAV_ITEMS = [
  {
    id: "cpp-manager",
    label: "CPP Manager",
    icon: Layers,
    href: "/apps",
  },
  // Thêm tools mới vào đây
];
```

### After
```typescript
import { Layers, Inbox } from "lucide-react";

const NAV_ITEMS = [
  {
    id: "cpp-manager",
    label: "CPP Manager",
    icon: Layers,
    href: "/apps",
  },
  {
    id: "store-submissions",
    label: "Store Management",
    icon: Inbox,
    href: "/store-submissions",
  },
];
```

## Notes

- **Icon**: `Inbox` từ lucide-react — phù hợp semantically (email-driven submissions). Có thể đổi `Package`, `LayoutGrid`, `Boxes` nếu muốn.
- **Active state**: `usePathname().startsWith(item.href)` đã handle `/store-submissions/*` tự động
- **Không cần update** `components/layout/TopNav.tsx` — AccountSwitcher có thể hide khi trong `/store-submissions/*` (Store Mgmt dùng shared mailbox, không có concept account switch). Tuỳ nhu cầu module.

## Verify

Sau khi patch:
```bash
pnpm dev
```

Mở `/`:
- Sidebar thấy 2 icons: Layers (CPP) + Inbox (Store)
- Hover → flyout hiện "CPP Manager" + "Store Management"
- Click Store icon → navigate `/store-submissions`
