# Runbook — capture Apple's real 429 body (pool investigation)

**Why this exists:** the body read from the last export's failure sheet was
**not Apple's**. It was `All ASC pool keys for account "vng-corp" are cooling
down` — a string this codebase produced (`ApplePoolExhaustedError`,
`lib/shared/apple-fetch.ts:94-108`) for an item that **never sent a request**.
Apple's real 429 body was dropped by the log line that omitted it. That line
now logs it (`#4`, shipped in `d6cff65`).

⚠ **Do this AFTER Railway finishes deploying `d6cff65`.** Before that, the
`body=` and `pool=` fields do not exist and the run tells you nothing new.

⚠ **DO NOT RUN A LARGE EXPORT.** `EXPORT_FETCH_CONCURRENCY = 8` is unchanged
(`lib/iap-management/apple/export-fetch.ts:50`), so a large export reproduces
the burst and re-parks the pool for an hour. One small action is enough.

---

## 1. The action

Apple IAP Management → **vng-corp** → an app → **Refresh from Apple**.
One click. Nothing bigger.

*(If that is not enough to produce a 429, an export of a handful of items is
the next smallest step — pick 3-5 items in the picker, not the whole app.)*

## 2. The greps — copy one at a time

```
# ⭐ THE ONE THAT SETTLES A/B/C — Apple's own words on the 429
[iap-apple] rate-limited

# the same line, isolated to the body field
body=
```
**One matching line is enough.** The body is identical on every 429 of the same
kind, so a second run adds nothing and costs another parked key. Copy the whole
line, including `pool=` and `retry-after=`.

```
# is the pool being used at all, and by which key
pool=key            # ✅ a pool key signed it — pool is live, in-memory Map clean
pool=off(empty)     # ⚠ this account has NO pool keys — seeded under another account?
pool=off(error)     # ⚠ the pool could not be read (Supabase / ENCRYPTION_KEY)
pool=n/a            # not an IAP call — CPP's path, no pool by design

# the pool refusing to send anything (internal, NOT Apple)
ALL POOL KEYS COOLING DOWN
```

⚠ **`ALL POOL KEYS COOLING DOWN` means no request was sent.** If you see it,
the 429-looking failures in that run came from us, not Apple, and there is no
Apple body to capture — clear a cooldown (Settings → API Key Pool → **Clear
cooldown**) and repeat step 1.

## 3. What each outcome decides

| You see | Means | Next |
|---|---|---|
| `rate-limited … body={…}` | ⭐ Apple's actual refusal | **Paste the body.** It decides A vs B vs C |
| `pool=off(empty)` on vng-corp | keys are under a different `account_id` | Fix the seeding; the pool has never been live here |
| `pool=key` and **no** 429 at all | pool is working on a small read | The 429 is burst-shaped — supports (A) |
| `ALL POOL KEYS COOLING DOWN` | our own latch, no Apple call | Clear cooldown, retry step 1 |

## 4. Two numbers still needed (not blocking)

1. **What time was `Test key` clicked?** Apple's window is a rolling hour, so
   `rem=3599` only proves the budget was untouched if the click landed *within*
   the hour after the 429 burst (`~07:56:47`–`08:56:47`).
2. **How many items did the failed export select?** At ~4 requests/item, under
   ~900 items **cannot** reach the 3,600/hour cap — which would rule out
   "budget exhausted" by arithmetic alone and leave the concurrency burst as
   the only remaining explanation.

## 5. What is NOT being changed yet

`EXPORT_FETCH_CONCURRENCY` (8), the cooldown duration (1 hour), and the
rotation logic are all untouched. A/B/C stay open until the body is read —
attributing this 429 to an unread signal is the mistake that caused the
incident. See TODO `[POOL-cooldown-misattribution]`.
