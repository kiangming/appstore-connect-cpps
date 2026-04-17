# Feature: Home Hub Page

> Designed: 2026-04-18 (session 16)
> Status: Designed — ready for implementation

---

## Tóm tắt

Thêm trang chủ hub (pure launcher) sau login, thay thế việc vào thẳng CPP Manager. Sidebar icon-only luôn visible ở tất cả pages trong dashboard, hover → flyout hiện label. Cho phép switch tool dễ dàng khi có nhiều tools trong tương lai (dự kiến 4–6 tools).

---

## Understanding Summary

- **Đang xây:** Trang chủ hub + global sidebar icon-only
- **Tại sao:** CPP Manager sắp không còn là tool duy nhất — cần landing rõ ràng
- **Người dùng:** 2–5 người nội bộ, thỉnh thoảng switch tool trong cùng session
- **Constraints:** Next.js 14 App Router, Tailwind, shadcn/ui. Style Apple HIG-inspired
- **Non-goals:** Không có recent activity, không có dashboard widgets, sidebar không toggle cố định

---

## Assumptions

- `TopNav` giữ lại bên trong mỗi tool (AccountSwitcher, user email/logout)
- Route `/` sau login → hub page; `/apps` vẫn là entry point CPP Manager
- Logo `C` trên sidebar = link về hub page `/`
- Hub page không thuộc tool nào → không có active indicator trên sidebar

---

## Layout Structure

```
(auth)/login              → không có sidebar
(dashboard)/layout.tsx    → sidebar luôn hiện (icon-only, 56px)
  /                       → Hub page (tool cards)
  /apps/...               → CPP Manager + TopNav bên trong
  /[tool-b]/...           → Tool mới + TopNav riêng
  /settings               → Settings page
```

### Tổng thể layout

```
┌──────┬─────────────────────────────────────────────────┐
│ 56px │ TopNav (full width của phần còn lại)            │
│      ├─────────────────────────────────────────────────┤
│  S   │                                                 │
│  I   │         Main Content                            │
│  D   │                                                 │
│  E   │                                                 │
│  B   │                                                 │
│  A   │                                                 │
│  R   ├─────────────────────────────────────────────────┤
│      │ (user avatar — bottom of sidebar)               │
└──────┴─────────────────────────────────────────────────┘
```

### DOM layout (`(dashboard)/layout.tsx`)

```tsx
<div class="flex h-screen">
  <AppSidebar />
  <div class="flex-1 flex flex-col ml-[56px]">
    <TopNav />          {/* chỉ hiện khi không phải hub page */}
    <AppSubNav />       {/* chỉ hiện khi trong /apps/[id]/... */}
    <main>{children}</main>
  </div>
</div>
```

---

## Sidebar Component — AppSidebar

### File

```
components/layout/AppSidebar.tsx   ← NEW
```

### Anatomy (icon rail)

```
┌──────┐
│  C   │  ← Logo, click → /
├──────┤
│  □   │  ← CPP Manager  (icon: Layers, href: /apps)
│  □   │  ← Tool B       (icon: TBD, href: /[tool-b])
├──────┤  ← flex-grow spacer
│  ⚙   │  ← Settings     (href: /settings)
├──────┤
│  👤  │  ← User avatar, click → dropdown (email + logout)
└──────┘
```

### Hover flyout behavior

- State: `const [hovered, setHovered] = useState(false)`
- `onMouseEnter` → `hovered = true` | `onMouseLeave` → `hovered = false`
- Flyout: `absolute left-[56px] top-0 h-full w-[180px]` — overlay, không đẩy content
- Background: `bg-white border-r shadow-md`

```
┌──────┬──────────────┐
│  C   │ CPP Manager  │
│ ▌ □  │▶ CPP Manager │  ← active item highlighted
│   □  │  Tool B      │
│      │              │
│  ⚙   │  Settings    │
│  👤  │  email@...   │
└──────┴──────────────┘
  56px    180px flyout
```

### Active state

```typescript
const isActive = usePathname().startsWith(item.href)
// active → blue left-bar: w-[3px] bg-[#0071E3] trên icon rail
```

### NavItem config

```typescript
const NAV_ITEMS = [
  {
    id: "cpp-manager",
    label: "CPP Manager",
    icon: Layers,
    href: "/apps",
  },
  // Thêm tools mới vào đây
]
```

---

## Hub Page — `/`

### File

```
app/(dashboard)/page.tsx   ← thay thế app/page.tsx hiện tại
```

### Spec

- Background: `bg-slate-50`
- Không có TopNav trên hub page
- Layout: centered, `max-w-xl mx-auto py-16 px-6`

### Wireframe

```
┌──────┬─────────────────────────────────────────────────┐
│  C   │                                                 │
│ ──── │                                                 │
│  □   │      Good morning, Minh                        │
│  □   │      Internal Tools                             │
│      │                                                 │
│      │      ┌───────────────────┐ ┌───────────────────┐│
│      │      │ □  CPP Manager    │ │ □  Tool B         ││
│      │      │                   │ │                   ││
│      │      │ Manage App Store  │ │ Short description ││
│      │      │ Custom Product    │ │ of the tool       ││
│      │      │ Pages             │ │                   ││
│      │      │           → Open  │ │           → Open  ││
│      │      └───────────────────┘ └───────────────────┘│
│ ──── │                                                 │
│  ⚙   │                                                 │
│  👤  │                                                 │
└──────┴─────────────────────────────────────────────────┘
```

### Tool Card spec

```
┌──────────────────────┐
│  icon (32px)         │  ← Lucide icon, color #0071E3
│                      │
│  Tool Name           │  ← font-semibold text-[17px] text-slate-900
│  Short description   │  ← text-[13px] text-slate-500
│                      │
│           → Open     │  ← text-[12px] text-[#0071E3], visible on hover
└──────────────────────┘
```

- Card: `bg-white rounded-2xl border border-slate-200 p-6 cursor-pointer`
- Hover: `border-[#0071E3] shadow-sm` transition 150ms
- Grid: `grid grid-cols-2 gap-4`

---

## TopNav Changes

Bỏ tabs "Apps" và "Settings" — hai items này chuyển sang sidebar.

TopNav sau khi update chỉ còn:
```
┌─────────────────────────────────────────────────┐
│  [AccountSwitcher]          [email] [logout]    │
└─────────────────────────────────────────────────┘
```

---

## Files cần thay đổi

| File | Action | Ghi chú |
|---|---|---|
| `components/layout/AppSidebar.tsx` | CREATE | Sidebar mới |
| `app/(dashboard)/layout.tsx` | MODIFY | Thêm `<AppSidebar />`, `ml-[56px]` |
| `app/(dashboard)/page.tsx` | CREATE | Hub page |
| `app/page.tsx` | MODIFY | Redirect → `/` dashboard hoặc xóa |
| `components/layout/TopNav.tsx` | MODIFY | Bỏ tabs Apps/Settings |
| `app/(dashboard)/settings/page.tsx` | CHECK | Đảm bảo vẫn accessible qua `/settings` |

---

## Mockup: Sidebar hover khi trong CPP Manager

```
┌──────┬──────────────┬──────────────────────────────────┐
│  C   │ CPP Manager  │  TopNav: [AccountSwitcher] [👤]  │
│ ──── │ ──────────── ├──────────────────────────────────┤
│ ▌ □  │▶ CPP Manager │  AppSubNav: [App icon] App Name  │
│   □  │  Tool B      │                                  │
│      │              │  CPP List content...             │
│      │              │                                  │
│ ──── │ ──────────── │                                  │
│  ⚙   │  Settings    │                                  │
│  👤  │  email@co... │                                  │
└──────┴──────────────┴──────────────────────────────────┘
  56px    180px flyout    main content (flex-1)
```

---

## Decision Log

| # | Quyết định | Alternatives | Lý do |
|---|---|---|---|
| 1 | Single shell layout trong `(dashboard)/layout.tsx` | Hub standalone layout / Sidebar chỉ trong tools | Ít code, consistent UX, không phá route hiện tại |
| 2 | Hub page = pure launcher (no widgets) | Activity feed / quick stats | YAGNI — team nhỏ, không cần |
| 3 | Redirect sau login → hub `/` | Vào thẳng CPP Manager | Cần landing rõ ràng khi có nhiều tools |
| 4 | Sidebar hover = flyout overlay (không đẩy content) | Toggle cố định / tooltip only | Tiết kiệm không gian, UX quen thuộc |
| 5 | TopNav giữ lại bên trong tools, bỏ tabs Apps/Settings | Bỏ hoàn toàn TopNav | AccountSwitcher + logout vẫn cần, refactor nhỏ nhất |
| 6 | Settings icon cuối sidebar | Tab trên TopNav / card trên hub | Tách biệt rõ khỏi tools, consistent với pattern sidebar |
| 7 | Tool cards: `grid-cols-2 max-w-xl` centered | Full-width grid / list view | 2–6 tools, card grid đẹp hơn list |
