# Patch: package.json — thêm dependencies cho Store Management

**File**: `package.json`

## Change

Thêm vào `dependencies`:

```json
{
  "dependencies": {
    // ... existing deps (next, react, jose, supabase, etc.)

    // ADDED for Store Management module:
    "googleapis": "^137.0.0",
    "re2-wasm": "^1.0.2",
    "zod": "^3.23.0",
    "react-hook-form": "^7.51.0",
    "@hookform/resolvers": "^3.3.0",
    "@sentry/nextjs": "^7.113.0",
    "sonner": "^1.4.0",
    "react-hotkeys-hook": "^4.5.0",
    "date-fns": "^3.6.0",
    "date-fns-tz": "^3.1.0",
    "papaparse": "^5.4.0",
    "recharts": "^2.12.0"
  },
  "devDependencies": {
    // ... existing devDeps

    // ADDED for Store Management module:
    "@types/papaparse": "^5.3.0",
    "vitest": "^1.6.0",
    "@testing-library/react": "^15.0.0"
  }
}
```

## Skip nếu đã có

Một số deps có thể đã cài cho CPP Manager:
- `zod` — nếu CPP đã dùng thì giữ version cao hơn
- `sonner` — nếu CPP đã dùng toast
- `date-fns` — nếu CPP đã dùng

Check trước bằng:
```bash
cat package.json | jq '.dependencies | keys'
```

## Install

```bash
pnpm add googleapis re2-wasm zod react-hook-form @hookform/resolvers @sentry/nextjs sonner react-hotkeys-hook date-fns date-fns-tz papaparse recharts
pnpm add -D @types/papaparse vitest @testing-library/react
```

## Notes

- **`re2-wasm`** (critical): NO native compilation needed, pure WASM → Railway deploy không gặp issue build tools. Alternative `re2` native nhanh hơn ~5x nhưng cần gcc+python build tools.
- **`googleapis`** package lớn (~30MB trong node_modules). Acceptable cho backend-only usage.
- **`@sentry/nextjs`**: chạy `npx @sentry/wizard@latest -i nextjs` để auto-setup config sau khi install.
- **`recharts`**: dùng cho Reports page của Store Management. Nếu CPP chưa dùng chart, đây là dep mới duy nhất lớn của UI.
