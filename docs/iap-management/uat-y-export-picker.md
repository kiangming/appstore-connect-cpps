# UAT — Export list item picker: pagination + shift-click (APPLE)

**Arc:** `arc-apple-export-picker-paging` · Y1 `b438556` · Y2 `d3a3106` ·
mockup repair `b6ca37f` · flake record `33a1d8d` · Y3 (this commit).
**Scope:** Apple IAP Management → an app → **Export list**. Nothing else.

⚠ **EVERY STEP OF THE PICKER COSTS ZERO APPLE REQUESTS.** Only the final
*Export* button reads Apple, at **~3 requests per selected item**. If any step
below feels slow or shows a spinner *before* you press Export, that is a
defect — say so, it is the feature's first acceptance criterion.

⚠ **Use an app with 60+ IAPs.** Below ~20 items there is one page and most of
this checklist is unreachable.

---

## 0 — Where things are

| Control | Where | Scope |
|---|---|---|
| `Select all N matching` | **text button**, top-left of the list | every item passing filters + search, **all pages** |
| `All` / `Selected (N)` | next to it | a **view**, selects nothing |
| `12 selected · 3 on this page` | top-right | **two tiers** — first number is what exports |
| `Select all N on this page` | **the one checkbox** at the head of the tick column | **this page only** |
| `Rows` 20/30/50 + `Prev / Page X of Y / Next` | the bar **below** the list | — |

---

## 1 — Pagination basics

- [ ] **1.1** Open *Export list*. The bar below the list shows
      `Showing 1–20 of N`, `Rows` = **20**, and `Page 1 of …`.
- [ ] **1.2** `Rows` is a **drop-down** (not three buttons) offering exactly
      **20 · 30 · 50**.
- [ ] **1.3** `Next` advances; `Showing` moves with it; `Prev` is greyed on
      page 1 and `Next` is greyed on the last page.
- [ ] **1.4** On a **single-page** result (search something narrow) the
      Prev/Page/Next cluster disappears but the `Rows` drop-down and the
      `Showing` line stay reachable.

## 2 — ⚠ THE ONE THAT MATTERS MOST: a pick that leaves the screen

- [ ] **2.1** Tick **one** item on page 1. Note its Product ID: `______`
- [ ] **2.2** Go to page 3. The counter still reads `1 selected`, and now
      `0 on this page`. ⚠ **It must show the `0`, not hide the clause.**
- [ ] **2.3** An amber line appears: *"+ 1 selected item is on other pages —
      still selected, and still part of the export."*
- [ ] **2.4** Tick one item on page 3, press *Continue to countries*, export.
      **Open the file: BOTH items are in it** — including the page-1 one.
      ⚠ If the page-1 item is missing, **stop and report**. This is the defect
      the whole chunk was built to prevent.
- [ ] **2.5** The footer says `Export 2 items · about 6 Apple requests` before
      you press anything.

## 3 — (A) vs (B): the two scopes

- [ ] **3.1** With `Rows` = 20 on an app of N items: press the **checkbox** at
      the head of the tick column ⇒ counter reads `20 selected · 20 on this page`.
- [ ] **3.2** Undo (press it again — its label now reads `Clear 20 on this
      page`), then press the **text button** `Select all N matching` ⇒ counter
      reads `N selected · 20 on this page`.
      ⚠ **3.1 and 3.2 must give DIFFERENT numbers.** If both give N, or both
      give 20, report it — that is the mis-click that costs money.
- [ ] **3.3** Page checkbox on page 1, then `Next`, then page checkbox again ⇒
      `40 selected`. Page 1's picks were **not** lost.
- [ ] **3.4** Tick **one** row by hand ⇒ the page checkbox shows a **dash**
      (partly ticked), and its label still says *Select*.
- [ ] **3.5** From that dash state, press it ⇒ it **fills the page** (1 → 20).
      ⚠ It must **never** clear from the dash state.

## 4 — Shift-click a range

- [ ] **4.1** Click a row's checkbox, then hold **Shift** and click a row a few
      rows below ⇒ everything between is ticked. Two actions.
- [ ] **4.2** Works **upwards** too (Shift-click a row *above* the first).
- [ ] **4.3** Tick a row somewhere else first, then do a range ⇒ the earlier
      pick is **still ticked**. The range only adds.
- [ ] **4.4** A row already ticked **inside** the range stays ticked.
- [ ] **4.5** ⚠ **Across pages: Shift-click the last row of page 1, go to page
      2, Shift-click a row** ⇒ only **that one row** is added, and a hint line
      explains why. **Nothing between is swept in.**
- [ ] **4.6** Shift-click as your very **first** action (no starting row yet) ⇒
      one row ticked **plus a visible hint**. Not silence.
- [ ] **4.7** The baseline tip is visible under the list whenever the list has
      rows, since the gesture has no button of its own.

## 5 — Rows / page-size behaviour

- [ ] **5.1** Go to page 3 at `Rows` = 20, then switch to `Rows` = 30. You land
      on **page 2**, looking at roughly the same rows.
      ⚠ You must **not** be thrown back to page 1, and **not** to the last page.
- [ ] **5.2** Tick 2 items, change `Rows`, and confirm the counter still says
      `2 selected`.
- [ ] **5.3** Change `Rows` to 50 on a short list ⇒ single page, no crash, picks
      intact.

## 6 — Search and filters vs the selection

- [ ] **6.1** Search a term matching items **beyond page 1** ⇒ they appear on
      **page 1 of the filtered result**. (Search filters everything, then pages.)
- [ ] **6.2** Search → tick → **clear the search** ⇒ the item is **still
      ticked** and the counter still counts it.
- [ ] **6.3** With a search active, press the **page checkbox** ⇒ it ticks the
      **filtered** page's rows only.
- [ ] **6.4** Tick an item, then change the **Type** filter so it is hidden ⇒
      the amber *"hidden by the current filters — still selected"* line appears
      and the count does **not** drop.
- [ ] **6.5** A row hidden by search sitting **between** two matches is **not**
      swept in by a Shift-click range.

## 7 — `Selected (N)` review view

- [ ] **7.1** Tick items on two different pages, press `Selected (N)` ⇒ only
      the ticked rows show, from both pages.
- [ ] **7.2** The page checkbox there reads **`Clear N on this page`** and is
      already checked.
- [ ] **7.3** Switch `Selected` → `All` → `Selected` ⇒ the selection is
      **unchanged** (it is a view, not a filter on the batch).

## 8 — Reopening (the Y3 fix)

- [ ] **8.1** Tick 2 items, export, wait for the file. Press **Export list**
      again ⇒ you land on **step 1 (choose items)**, **nothing ticked**, and
      the button reads `Select at least 1 item`.
      ⚠ Before this cycle it reopened straight onto the **country** step with
      the old ticks still in place.
- [ ] **8.2** Same after **Cancel**, and after the **✕**.
- [ ] **8.3** Reach step 2, press *Cancel* (which means **Back**) ⇒ step 1 with
      the selection **still there**. Then Cancel out and reopen ⇒ clean.

## 9 — Unchanged behaviour (regression guard)

- [ ] **9.1** The three filters still read Apple's **raw** status values
      (`APPROVED`, `DEVELOPER_REMOVED_FROM_SALE`, …) — not translated.
- [ ] **9.2** The `Availability as of …` line still shows above the list.
- [ ] **9.3** Local drafts still appear under **Cannot be exported**, disabled,
      with a reason.
- [ ] **9.4** Step 2 (countries) is unchanged, and still offers Apple's markets
      (Russia present, Andorra absent).
- [ ] **9.5** ⚠ **Set Availabilities / Choose territories / Remove from Sales
      are UNCHANGED** — no pages, no `Rows`, no shift-click, and `Select all`
      is still a checkbox there. **This is deliberate** (a write path); if any
      of it changed, report it.

## 10 — If something is wrong

Report with: the app, the `Rows` value, which page, the **two counter numbers**
as shown, and what the exported file actually contained. The two numbers are
the fastest way to tell a display bug from a selection bug.

⚠ **Do not report the number of ticked rows you counted on screen** — with
pagination that undercounts by design. Use the counter and the
`Export N items · about 3N Apple requests` line.
