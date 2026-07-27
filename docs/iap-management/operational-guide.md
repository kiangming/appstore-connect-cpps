# Apple IAP Management — Operational Guide

This guide currently covers two topics: reading Bulk Import results
(including the new expandable Apple error detail), and configuring
VNGGames Hub run tracking. For pricing templates, see
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
