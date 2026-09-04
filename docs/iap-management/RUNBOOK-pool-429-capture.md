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

## 3b. Reading the run that already failed (632 items, 556 ok, 76 failed)

⚠ **That run predates `d6cff65`, so its logs have NO `body=` and NO `pool=`.**
These greps work on the OLD format only. They cannot produce Apple's 429 body —
only §1-2 above can, on a NEW run.

```
# WHEN it started, and how fast it was going.
# One line per item, so the count also tells you which item number the 429 hit.
[get-schedule] stage1 fetching

# The 429 itself — expect the timestamp 14:56:49
rate-limited (retry-after=

# ⭐ HOW MANY 429s LANDED TOGETHER. 8 lines at the same second = the burst
# amplification is confirmed on this run. Fewer = the burst was narrower.
[key-pool] 429-headers

# our own latch firing (no request sent) — everything after this is NOT_ATTEMPTED
ALL POOL KEYS COOLING DOWN
```

**What to compute, and what it is worth:**

| From | Number | Meaning |
|---|---|---|
| first `stage1 fetching` → `14:56:49` | elapsed | with 556 items ≈ 2,224 requests ⇒ **requests/minute** |
| count of `429-headers` at 14:56:49 | 1-8 | **8 ⇒ amplification confirmed** |
| count of `stage1 fetching` before 14:56:49 | item index | where in the run it broke |

⚠ **The requests/minute figure is an OBSERVATION, not a verdict.** This repo
documents **no** Apple per-minute or per-second limit — `grep` for a 429 error
taxonomy returns nothing, and KB §4.9 only ever measured the **hourly**
`user-hour-lim:3600`. Do not compare the number against an invented threshold.
Its only use is as a data point to hand Apple, or to compare against a *future*
run at the lower concurrency.

## 3c. Counting the 76 failures from the sheet

Open **"Export Failures"** → column **`Reason`**:

| `Reason` | Meaning | Re-exportable? |
|---|---|---|
| **Rate limited** | a 429 that survived all 4 attempts (`export-fetch.ts:102-103`) | yes |
| **Not attempted** | the latch had already stopped the run; **nothing was sent** (`export-fetch.ts:207`) | yes — this is the count that is always safe |
| Apple refused / Unknown / Incomplete prices / Base territory unreadable | unrelated to rate limiting | case by case |

⚠ **"Rate limited" here does NOT prove Apple said so.** Our own
`ApplePoolExhaustedError` is reported under the same label
(`[POOL-exhaustion-reported-as-apple-429]`), and its `Detail` column reads
`429: All ASC pool keys for account "…" are cooling down` — that string is
**ours**. A row whose Detail mentions "pool keys" never reached Apple. Split
the 76 by that before drawing any conclusion.

## 4. Both outstanding numbers are now ANSWERED — and one refuted a diagnosis

~~1. What time was `Test key` clicked?~~ ✅ **15:31:31, i.e. 34m42s after the
   429 at 14:56:49 — INSIDE Apple's rolling hour.** So `rem=3599 lim=3600` is a
   genuine reading of an **unspent** budget, not a post-recovery one.

~~2. How many items did the failed export select?~~ ✅ **632 selected, 556
   completed, 76 failed.** ⇒ ≈2,224 requests over 7 keys ≈ **318/key** against
   3,600/hour ⇒ **hourly budget ruled out by arithmetic too.**

⚠ **AND IT REFUTED "the export died on the first burst".** 556 items went
through at concurrency 8 *before* any 429, so width 8 was **not the trigger** —
it was the **amplifier** (one 429 with 8 in flight ⇒ 7 keys parked in 394ms).
A window **shorter than an hour** (per-minute / per-second / burst) is the only
surviving hypothesis and has **no evidence yet**. §1-2 is how to get it.

## 5. What is NOT being changed yet

`EXPORT_FETCH_CONCURRENCY` (8), the cooldown duration (1 hour), and the
rotation logic are all untouched. A/B/C stay open until the body is read —
attributing this 429 to an unread signal is the mistake that caused the
incident. See TODO `[POOL-cooldown-misattribution]`.
