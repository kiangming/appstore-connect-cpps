# Apple IAP Management — Operational Guide

This guide currently covers three topics: reading Bulk Import results
(including the new expandable Apple error detail), configuring
VNGGames Hub run tracking, and per-territory custom prices. For pricing templates, see
[pricing-templates-guide.md](pricing-templates-guide.md). For the full
step-by-step tour of every feature (Apps list, Create/Edit IAP, View
Detail, Bulk Availabilities, Submit batch, …), see the standalone
documentation site (`docs/user-docs/index.html`).

## TL;DR

- **Bulk Import Step 4 (Result)** now shows a short, readable summary of
  what went wrong on a failed row, with a **Detail** button that expands
  the complete Apple error — no more digging through Railway logs.
- **Hub Tracking** (Settings → Hub Tracking) is one on/off switch per
  module (Apple, Google) that reports each tracked operation's outcome to
  the VNGGames Hub dashboard. It's optional — off, everything works
  exactly the same, just without dashboard visibility.
- **Custom territory prices** (Edit IAP → Pricing) let you override the
  price for any single territory, on top of whatever pricing source the
  IAP uses. The one thing to read before using it: **Apple replaces the
  whole price schedule on every push**, so any price you set by hand in
  App Store Connect disappears on the next push unless you import it as
  a custom price first. §3 explains the flow.

## 1. Reading Bulk Import results & viewing error detail

After running a Bulk Import (Step 4 — Result), each row shows its
status, disposition, outcome, price, and a **Notes** column.

### Collapsed view (default)

For a row that failed, the Notes column shows a short, human-readable
summary — the operation stage plus Apple's own explanation, e.g.:

> `apple-create 409 — This name is already being used for another In-App
> Purchase for this app.`

If Apple's error isn't something the tool can summarize (a network error
or timeout, for instance), the Notes column falls back to showing the raw
message instead — still short, still readable.

### Viewing the full error

Click **Detail** under the summary to expand the row. This reveals the
complete error exactly as Apple returned it, formatted for readability.
If it runs long, it scrolls inside the cell instead of pushing the table
around. Click **Close** to collapse it back to the short summary.

Each row expands independently — opening one row's detail doesn't affect
any other row, so you can compare several failures side by side.

This also applies to the "submit failed" note on a row that was
successfully **created** but failed the follow-up submit-to-review step —
it gets the same summary + Detail/Close treatment.

### Reading (not guessing) the cause

The Notes detail tells you exactly what Apple said — read it as Apple's
own explanation, not a tool-generated diagnosis. One case worth calling
out because it's common and unambiguous:

- **`409 — This name is already being used for another In-App Purchase
  for this app.`** — the row's reference name collides with an IAP that
  already exists on Apple for this app. Fix: rename the reference name in
  your import file (or in the conflicting existing IAP) and re-run the
  row.

For any other error text, treat the Detail panel as the authoritative
description of what Apple rejected and why — if the cause isn't obvious
from Apple's own wording, that's a signal to check the IAP directly in
App Store Connect rather than guess.

## 2. Hub tracking — VNGGames Hub run visibility

Hub tracking is an **optional** integration that reports each tracked
operation's outcome to the VNGGames Hub dashboard, so you can see recent
runs (and whether they succeeded) without opening the tool. It never
blocks or changes how an operation itself behaves — if tracking is off,
misconfigured, or the Hub is unreachable, the operation runs exactly the
same either way.

### Where to configure it

Each module has its own toggle, under that module's Settings:

- **Apple IAP Management** → Settings → **Hub Tracking**
  (`/iap-management/settings/hub-tracking`)
- **Google IAP Management** → Settings → **Hub Tracking**
  (`/google-iap-management/settings/hub-tracking`)

Both pages have the same three fields:

| Field | What it does |
|---|---|
| **Tracking enabled** | Master on/off switch for that module. Turning it off fully disables tracking — the underlying operations keep working exactly as before, nothing is deleted. |
| **Workflow ID** | The Hub workflow this module reports into. It must already be registered in Hub Admin → Workflows — an unregistered ID is rejected on Save. |
| **Token** | The Hub ingest token. Write-only — once saved it's never shown again; leave it blank on a later save to keep the existing token. |

Editing these fields is admin-only — non-admin users see the same page
read-only with an "Admin-managed" label. Saving validates the Workflow
ID / Token against the Hub immediately; if the Hub rejects them or isn't
reachable, you'll see a warning banner (the save still goes through, but
tracking may silently no-op until it's fixed).

### What's tracked

One Apple toggle covers every Apple operation below (they all report
into the same Workflow ID); the Google toggle is separate and covers
Google's own operations:

- **Apple:** Bulk Import, Submit (single + batch), Set Availabilities,
  Remove from Sales.
- **Google:** Bulk Import, Bulk Activate, Bulk Deactivate.

### Reading the terminal status on the Hub dashboard

Each tracked run closes with one of four statuses:

| Status | Meaning |
|---|---|
| **SUCCESS** | Every item in that run reached its goal state (created, submitted, availability set, etc.) |
| **PARTIAL** | Some items reached the goal state, some didn't |
| **FAILED** | Nothing in that run reached the goal state |
| **CANCELLED** | The run was backed out before any real write happened — closing the dialog, navigating away, or a reconfirm-and-decline before anything was sent to Apple/Google. If real writes had already started, the run reports FAILED or PARTIAL instead of CANCELLED, since something did happen. |

A run showing `RUNNING` and never resolving usually means the browser
tab was closed mid-operation — a known, low-volume gap (no auto-expiry
today); it doesn't mean the underlying operation failed, just that its
dashboard entry was never closed out.


---

## 3. Per-territory custom prices

Available on the **Edit IAP** form → *Pricing* → **Custom territory
prices**. Overrides the price for the territories you pick; every other
territory keeps exactly what it had (template value, or Apple's automatic
equalisation).

Works with all three pricing sources — Apple base data, Default
Template, App-specific Template. Under *Apple base data* your customs are
the only per-territory overrides in the push.

### Why it needs a saved draft first

The button is disabled on the **New IAP** form with *"Save as draft
first"*. Custom prices are stored against the saved IAP row, and every
create already goes through a saved draft — there is no *Create on
Apple* button on the New form, only on Edit. So this adds no step the
create flow didn't already require.

### ⚠ The important one: existing hand-set prices are erased on the next push

Apple's price-schedule API is **replace-all**: every push replaces the
entire schedule. A price you set manually in App Store Connect is not
part of what the tool sends, so the next push silently reverts that
territory to Apple's automatic price.

**This has always been true.** What changed is that the dialog now shows
it, and offers the fix in the same view:

1. Open **Edit IAP → Pricing → Custom territory prices**.
2. Rows priced by hand on Apple show the pill `on Apple now` and the
   line *"will revert to auto on the next push unless you import it as a
   custom price"*.
3. If any exist, a banner at the top counts them:
   *"N territories have a price set on Apple that the next push will
   erase"* → **Import all as custom prices**. Per-row, use the
   *Import as custom price* link on the row itself.
4. The imported value is Apple's current price, unchanged — the point is
   that it survives.
5. **Save custom prices.**

Do this **before** any Update on Apple on an IAP whose prices were
touched in App Store Connect.

### Reading a row

| Pill | Means | Number shown? |
|---|---|---|
| `base tier` | The base territory (USA). Read-only here — change it in the **Price Tier** field. | Yes |
| `on Apple now` | What Apple charges today, set by hand. **Erased by the next push** unless imported. | Yes |
| `template · unverified` | What the active pricing template says. Called *unverified* because if Apple has no matching price point the push silently falls back to the automatic price. | Yes |
| `Apple equalises` | Apple derives this one from the base price. | **No — shows `— auto —`.** The tool cannot reproduce Apple's calculation, and showing a plausible-looking figure would read as Apple's real price. |

Prices come from a dropdown of the points Apple actually supports in that
territory — never a free-text box. The list loads when you open that
row's dropdown (not for all ~175 territories at once). Search matches
country name, 3-letter code, or currency; the continent pills and
*Only customised* narrow the list further.

### Undoing

- **One territory** — pick the `— use template … —` / `— use auto —`
  option, or the row's **Revert ×**.
- **All** — **Clear all custom prices**, in the dialog footer and on the
  Pricing section itself. The removed values are written to the audit log.

### Changing the base price after setting customs

Changing the **Price Tier**, the **pricing source**, or the base
territory makes existing customs **stale**. Nothing is deleted, but
**Create/Update on Apple is blocked** until you resolve it:

- **Keep them (reviewed)** — keeps every value and re-stamps them against
  the new base. Change the base again and it asks again.
- **Clear all custom prices** — removes them.
- **Change the base back** — the warning disappears on its own, nothing
  to click.

### When a custom cannot be applied

If Apple has no price point for a territory at the price you picked (it
was withdrawn since you chose it, for example), that territory is
reported **red** and named — e.g. *"custom prices NOT applied for 1
territory: VNM (no-apple-price-point)"*. The rest of the push still goes
through. Unlike a template entry, a custom does **not** quietly fall back
to the automatic price: you asked for a specific price in a specific
territory, so a failure is reported as a failure.

Re-opening the dialog re-checks stored customs against Apple's current
list and flags anything withdrawn with `no longer offered`.

### If the picker is unavailable

The tool reads Apple's price list through an IAP that already exists on
Apple. In an app where nothing has been created yet, the picker is
disabled with that reason — create the IAP first, then edit it to add
custom prices.
