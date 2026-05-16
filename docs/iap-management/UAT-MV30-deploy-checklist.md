# UAT MV30 — Post-Deploy Verification Checklist

When a fresh build ships to Railway, the browser may still hold stale JS
chunks and a stale NextAuth JWT. Run this checklist **once** at the start of
every UAT cycle before reporting bugs against the new code — many "feature
not working" reports across IAP.o.6–IAP.o.8 traced back to deploy lag or
client cache rather than real defects.

## 1. Verify Railway deploy shipped

The latest commit on `main` must show up in production before testing. Quick
verification: open the IAP Management hub page and check the page source for
the latest commit SHA (when surfaced) or hit a known-changed endpoint.

If still on the previous build, wait 2–3 minutes for Railway to finish the
deploy. Re-test from step 2 once the new SHA is live.

## 2. Hard refresh the browser

Browser cache holds Next.js JS chunks for ~5 minutes. Without a hard refresh,
new client-side code (e.g., new checkbox columns, new buttons) will not
appear even after Railway deploys.

- **Chrome / Edge (macOS):** Cmd + Shift + R
- **Chrome / Edge (Windows):** Ctrl + Shift + R
- **Safari:** Cmd + Option + R

## 3. Sign out + sign in

NextAuth caches the user's JWT (including the `role` claim from
`ADMIN_EMAILS`) for the session lifetime. When environment variables change
or role-gated routes are touched, the existing JWT is stale.

1. Click avatar → Sign out
2. Sign back in via Google SSO
3. New JWT minted server-side

## 4. Click "Refresh from Apple" once

The IAP list cache is database-backed. After deploy, the cached data may
predate the new schema or response shape. Click the "Refresh from Apple"
button on the IAP list page once to pull a fresh snapshot.

## 5. Then verify the feature under test

Only after steps 1–4 should you start verifying:

- New columns appear (checkbox, Price, etc.)
- New buttons work (Submit Selected, etc.)
- Row click navigation lands on the View page
- Bulk-import wizard progresses through all 4 steps
- View detail page shows real-time Apple state

## Manager UAT — Bug capture protocol

If a feature still misbehaves **after** completing steps 1–4:

1. Open browser DevTools → Console tab
2. Reproduce the issue
3. Capture any red errors + the network request that failed
4. Note the exact build SHA + your browser version
5. Attach the screenshot + console capture to the bug report

This lets the dev team distinguish "client-stale" reports from real
regressions, and surfaces real bugs with the diagnostic context needed to
patch within a single round trip rather than the multi-cycle hotfix loops
that cost IAP.o.7–IAP.o.9 ~5 cumulative rounds.

## Test data hygiene

Apple's IAP `productId` is **permanently claimed** once created — even
deleted IAPs leave the productId reserved. To keep UAT runs reproducible:

- Use namespace `com.vng.test.iap.YYYYMMDD.vN.NNN` per UAT cycle
- Each cycle: bump `vN` so productIds are fresh
- Document the namespace at the top of the UAT pass

Avoid re-using `com.vng.test.iap.*` from previous cycles — Apple will return
409 ENTITY_ERROR and the import path will be exercised against an
artificially-polluted state.
