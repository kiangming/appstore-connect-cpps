# TODO — Tech Debt & Deferred Work

Format: `- [ ] [PR-X] description — file path — rationale`

## From [TEMPLATE-xlsx-export] (export ma trận Pricing Template ra .xlsx, 2026-08-30)

**Trạng thái arc: code xong C1–C6, chờ Manager UAT trên production.** Kiến
trúc + bài học: **KB §21**. Không có migration nào ⇒ đường lui là Railway
Rollback về `7951eae`, DB không liên quan.

- [ ] [TEMPLATE-xlsx-reimport] ⚠ **HOÃN CÓ CHỦ ĐÍCH — file .xlsx export ra CHƯA nạp ngược lại được.** Manager chốt arc này CHỈ LÀM EXPORT; round-trip sẽ ra yêu cầu riêng nếu cần. Sự thật đã điều tra, ghi lại để lần sau khỏi làm lại:
  - Importer đòi: `.xlsx`, **sheet tên `price_tiers`** (`lib/iap-management/parsers/price-tiers.ts:36`), header hàng 0 khớp `/^(.+?)\s*\(([A-Z]{3})_([A-Z]{3})\)\s*$/` tức `United States (USA_USD)` (`:37`), hàng 1 sub-header **`Price` / `Proceeds`** (`:206-217`), cột 0 là tên tier khớp `Free Tier` / `Tier N` / `Alternate Tier X` (`:90-106`).
  - File export mới: sheet `Default Template` / `Per-App Template`, header tên nước trần (không có `(AAA_CCC)`), sub-cột **`Price` / `Currency`**.
  - **4 khoảng cách**: tên sheet · header nước thiếu `(AAA_CCC)` · `Currency` ≠ `Proceeds` · **`proceeds` KHÔNG có trong `MatrixData`**.
  - ⚠ Mục thứ 4 là mục quyết định: round-trip **không phải** đổi nhãn cột — nó cần dữ liệu mà `MatrixData` hôm nay không mang, tức một đường đọc mới. Đừng ước lượng nó như một việc nhỏ.
- [ ] [TEMPLATE-xlsx-export] **Chỉ Apple có export ma trận .xlsx; Google vẫn CSV.** `lib/google-iap-management/csv-export.ts` + hai màn matrix của Google còn nguyên đường CSV cũ, kèm cả ba lệch F1/F2/F6 tương ứng (Google `PerAppMatrixView.tsx:75` cũng truyền `includeDefaultDiff` chứ không phải công tắc). ⚠ **Đừng port 1:1** (P8): Google là **micros** (`formatPriceForCsv(priceMicros, currency)`) còn Apple là decimal; Google khoá theo `packageName`, Apple theo `bundleId`. Cần census riêng trước khi thiết kế.
- [ ] [TEMPLATE-xlsx-export] **`X-Export-Tier-Count` / `X-Export-Territory-Count` chưa có test canh Ý NGHĨA, mới canh giá trị.** Khác với 6 header của export item list (§4.21 — mỗi cái trả lời một câu hỏi khác nhau và có file test riêng pin định nghĩa). Hai header này hôm nay chỉ nuôi một dòng toast; nếu có surface thứ hai đọc chúng thì cần pin định nghĩa trước.

## From [ACCOUNT-default-template] (Default Template theo từng ASC account, 2026-08-29)

**Trạng thái arc: ✅ SHIPPED (2026-08-29).** Code C-A…C-E deploy `0d4b3b3`
· UAT 8/8 xanh · M-1 apply + M1-V0 `TAT_CA_PASS=true` · M-2 apply + M2-V1…V4
7/7 xanh · dọn hậu 2.1–2.5. Kiến trúc + bài học: **KB §19** (§19.8 phần đóng,
§19.9 quy tắc đường-ghi/đường-đọc).

⚠ **CÒN ĐÚNG MỘT VIỆC TREO:** dọn 2 bảng backup — mục ngay dưới. Nó KHÔNG
phải việc dọn dẹp cho gọn; nó là đường lui đọc được duy nhất sau khi dòng
GLOBAL bị xoá, nên có điều kiện mở khoá riêng.

- [x] [HEALTHCHECK] **Bật lại Railway Healthcheck Path = `/api/health`** — ✅ 2026-08-29. Route `/api/health` lên production ở `b5a0fc9`, Manager đã trỏ Healthcheck Path sang đó, deploy xanh. (Lý do không trỏ lại `/`: nó `redirect("/login")` từ commit đầu tiên nên healthcheck không bao giờ nhận 2xx.)
- [ ] [HEALTHCHECK-openq] **CÂU HỎI MỞ: vì sao healthcheck `/` xanh nhiều tháng rồi đỏ ngày 29/08?** — không giải thích được từ repo. Đã loại trừ bằng git: `/` trả 307 từ `c922f83` (2026-03-12) · file trên đường render `/` và `/login` không đổi giữa deploy xanh `d713dd5` và deploy đỏ `0d4b3b3` · `next.config.mjs`/`package.json` không đổi · `next` vẫn 14.2.35 chưa từng bump · `middleware.ts` chưa từng tồn tại. Giả thuyết còn lại nằm phía Railway (trước đây chấp nhận hoặc đi theo 307, nay không) — **chưa chứng minh được, đừng ghi thành kết luận**. Nếu Railway có changelog/support thì hỏi; nếu không thì để mở.

- [x] [ACCOUNT-default-template] **Apply M-2** — ✅ apply 2026-08-29, verify M2-V1…V4 **7/7 xanh**: 0 GLOBAL · 6 ACCOUNT · 3 APP · 9 tổng; `tong_entry_account` = `ky_vong` = 6840 và tổng bảng 41103 = 6840 + 34263 của 3 template APP (khớp M1-V7) ⇒ CASCADE chỉ dọn đúng dòng GLOBAL; 2 CHECK không còn `'GLOBAL'`; 4 index, `global_unique` đã drop; backup còn nguyên 1 header / 1140 entry; **6 dòng audit với `source_uploaded_by` = tác giả thật, `source_uploaded_at` = 2026-05-18 ⇒ dấu vết tác giả gốc SỐNG SÓT, bẫy KB §9 P2 không kích hoạt.**
- [ ] [ACCOUNT-default-template] ⚠ **VIỆC TREO DUY NHẤT CỦA ARC — dọn 2 bảng backup.** `iap_mgmt.price_tier_templates_backup_global` + `iap_mgmt.price_tier_template_entries_backup_global` (1 header / 1140 entry). **ĐIỀU KIỆN MỞ KHOÁ: sau ÍT NHẤT MỘT LẦN SUBMIT THẬT lên Apple bằng template ACCOUNT — submit thật, KHÔNG phải preview.**

  Vì sao preview không tính: preview không đi qua đường ghi, nên nó không chứng minh được vế còn thiếu. M2-V1…V4 xanh chỉ chứng minh **dữ liệu đúng trong database**; nó không chứng minh **orchestrator đọc đúng dữ liệu đó rồi POST đúng giá lên Apple**. Chỉ một lần submit thật mới nối được hai vế.

  Vì sao đừng dọn sớm: M-2 đã xoá dòng GLOBAL (`route`: migration bước 1). Hai bảng này là **đường lui duy nhất còn ĐỌC ĐƯỢC** — dữ liệu tuy cũng sống trong 6 bản sao ACCOUNT, nhưng muốn dựng lại đúng một dòng GLOBAL nguyên bản thì chỉ có ở đây. ⚠ Dựng lại cần nới CHECK trước, vì M-2 đã cấm giá trị `'GLOBAL'`.
- [x] [ACCOUNT-default-template] **Bỏ bí danh `scope="GLOBAL"` ở POST /pricing-templates** — ✅ chunk 2.1 (`0b1d072`). `app/api/iap-management/pricing-templates/route.ts:93`. Chữ `"GLOBAL"` nay rơi xuống `else` sẵn có ⇒ 400 `'scope must be "ACCOUNT" or "APP".'`. Test mới `route.scope-rejection.test.ts` canh **cách** từ chối chứ không chỉ việc từ chối: 400 phải kèm message, message nêu đủ hai giá trị hợp lệ, `replaceTemplate` không được gọi, và `getActiveAccount` không được gọi (nhánh nguy hiểm nhất nếu gỡ ẩu). Census kèm theo: **không có zod schema nào cho `scope`** — đây là so sánh chuỗi thô.
- [x] [ACCOUNT-default-template] **Bỏ `'GLOBAL'` khỏi union `TemplateHeader.scope_type`** — ✅ chunk 2.1 (`0b1d072`). `lib/iap-management/queries/templates.ts:48` nay là `"APP" | "ACCOUNT"`; gate admin của DELETE (`[templateId]/route.ts:64`) chỉ còn bám `"ACCOUNT"`. Thu hẹp kiểu là **guard cấu trúc**, không phải dọn dẹp: mọi `=== "GLOBAL"` còn sót từ nay là lỗi `tsc` thay vì một nhánh chết chạy im lặng.
- [x] [ACCOUNT-default-template] **Comment/fixture còn nói scope GLOBAL như đường sống** — ✅ chunk 2.2 (`a6f701b`). Grep ra **11 chỗ trong 8 file**, không phải 1 (bài học C-E lặp lại). Giữ nguyên có lý do: `batch-price-point-catalog.ts:7` + `price-point-donor.ts:10` (chữ GLOBAL ở đó là catalog giá toàn cầu của Apple, nghĩa khác hẳn), các đoạn lịch sử đã đúng thì quá khứ, các guard hồi quy còn sống, và `DefaultTemplateTab.test.tsx:53` (chuỗi `origin_note` là dữ liệu thật migration ghi vào DB).
- [x] [ACCOUNT-default-template] **Không test nào bấm nút Replace/Remove** — ✅ chunk 2.3 (`27f6dda`). Mọi test cũ gọi `fireEvent.change` thẳng lên `<input type=file>` ⇒ `onClick` là vùng không ai canh. Thêm 5 test ở `DefaultTemplateTab.test.tsx` describe (g). ⚠ **Lỗ tương tự CHƯA vá** ở hai surface sinh đôi — xem mục `[PERAPP-REMOVE-no-test]` bên dưới.
- [x] [ACCOUNT-default-template] **Tên account chưa từng đọc được** — ✅ xác nhận ở UAT 8/8 (2026-08-29): nhãn hiện ra là tên người đọc được. Bằng chứng mạnh nhất là mục quyết định của UAT — TopNav = NCV, app `sa.lw.ap.104` hiện option **"Default Template · NCV"**; NCV là account CUỐI danh sách nên nó cũng loại trừ luôn giả thuyết "rơi về account đầu danh sách".
- [ ] [ACCOUNT-default-template] **`asc_account_keys.account_id` không có guard cấu trúc tương đương** — `lib/iap-management/queries/templates.structure.test.ts` chặn truy cập thẳng 2 bảng template; bảng key pool (cũng soft-ref sang `public.asc_accounts`) chưa có guard cùng loại. Không cấp bách — nhưng nếu key pool mọc thêm surface thì đây là khuôn có sẵn.

- [ ] [PERAPP-REMOVE-no-test] **Hai surface template KHÔNG CÓ FILE TEST NÀO — nút mở file picker và nút Remove đều không ai canh.** Sinh ra từ census của chunk 2.3: tab Default ít nhất có 21 test và nay có canh wiring nút; hai surface sinh đôi thì không có gì.

  - `app/(dashboard)/iap-management/settings/pricing-tiers/PerAppTemplateTab.tsx:259` (mở file picker) + `:356` (Remove theo từng hàng app)
  - `components/iap-management/pricing-tiers/AppPricingTemplateSection.tsx:190` (mở file picker) + `:182` (Remove)

  Khuôn có sẵn, chép từ `DefaultTemplateTab.test.tsx` describe (g): spy `HTMLInputElement.prototype.click` → `fireEvent.click` nút → assert spy được gọi; và với Remove thì assert DELETE đúng id **cộng** assert huỷ ở `window.confirm` thì KHÔNG gọi DELETE (khẳng định thứ hai là thứ phân biệt "nút nối vào handler có hỏi" với "nút nối vào một fetch DELETE trần").

  ⚠ Không rẻ như tab Default: cả hai component fetch trong `useEffect` (`PerAppTemplateTab` còn có `fetchInFlight` chống trùng lời gọi), nên phải dựng harness mock vòng fetch trước. Đó là lý do chunk 2.3 dừng ở tab Default và ghi mục này thay vì làm cố.

  ⚠ Nút Remove ở `PerAppTemplateTab:356` xoá template của MỘT app, không phải của account — bán kính nổ nhỏ hơn nút Remove ở tab Default. Đừng chép nguyên câu chữ cảnh báo sang.

- [ ] [PERAPP-account-picker-asymmetry] **Tab Per-App bám account TopNav, tab Default có dãy chip — hai tab cạnh nhau, hai cách chọn account.** Sau C-D, tab Default cho Manager chọn account bằng dãy chip và XEM/SỬA template của một account KHÁC account đang active. Tab Per-App ngay bên cạnh thì không: danh sách app đến từ `GET /api/iap-management/asc-apps`, và route đó tự suy account bằng `getActiveAccount()` (`app/api/iap-management/asc-apps/route.ts:39`), không nhận tham số. Muốn thấy app của account khác thì phải đổi ở TopNav.

  **Đây là chỗ THỨ HAI của pattern "route tự suy account từ `getActiveAccount`".** Chỗ thứ nhất là `POST /api/iap-management/pricing-templates` — đã sửa ở C-D, và phải sửa, vì đó là **đường GHI**: chọn account B ở dãy chip rồi bấm Replace sẽ ghi đè template của account A, mất 1140 ô thật, im lặng, và bản bị mất là bản Manager đang không nhìn (lập luận đầy đủ ở `app/api/iap-management/pricing-templates/route.ts:103-110`). Chỗ này là **đường ĐỌC** — hậu quả tối đa là bất tiện: danh sách hiện app của account khác với account Manager đang nghĩ tới. Không mất dữ liệu. Đó là lý do nó nằm ở backlog chứ không phải trong arc.

  ⚠ **Cách phân biệt hai chỗ này, để lần sau khỏi phải nghĩ lại:** không phải "route nào cũng phải nhận `account_id`", mà là **đường ghi thì account PHẢI đến từ client và phải được đối chiếu; đường đọc thì suy từ active là chấp nhận được, miễn có nói ra là nó suy từ đâu.**

  **Đã làm (chunk 2.4, 2026-08-29):** phương án (ii) — thêm một dòng ở tab Per-App nói rõ danh sách bám account TopNav và vì sao (`app/(dashboard)/iap-management/settings/pricing-tiers/PerAppTemplateTab.tsx`, ngay dưới dòng "Apps from ASC account:"). Rẻ, và nó chữa đúng cái hại thật: Manager vừa dùng dãy chip ở tab Default xong, sang đây đi tìm dãy chip, không thấy, và **đọc sự vắng mặt đó là hỏng**.

  **CHƯA làm — phương án (i), đầy đủ**, nếu về sau thấy đáng:
  1. Tách dãy chip chọn account ở `DefaultTemplateTab.tsx` thành component dùng chung, đặt cạnh hai tab (hoặc lên tầng `PricingTiersClient` để một lựa chọn áp cho cả hai tab).
  2. `GET /api/iap-management/asc-apps` nhận `?account_id=`, đối chiếu với `findAllAccountsPublic()` y như `POST /pricing-templates` đang làm, và **fallback về `getActiveAccount()` khi thiếu tham số**. Caller: grep ngày 2026-08-29 ra **đúng MỘT caller sống** — `PerAppTemplateTab.tsx:61`; ba chỗ còn lại là comment (`pricing-tiers/page.tsx:28`, `queries/templates.ts:84`) và danh sách đường dẫn trong `rbac-posture.test.ts:38`. Nên bước này rẻ hơn vẻ ngoài. ⚠ Vẫn grep lại lúc làm — route nằm NGOÀI module template, con số này là ảnh chụp một ngày.
  3. `PerAppTemplateTab` truyền account đang chọn vào lời `fetch`, và `refreshAscApps()` chạy lại khi lựa chọn đổi (hiện chỉ chạy lại khi mở dropdown — `onMouseDown`).
  3b. ⚠ **RÀNG BUỘC ẨN, tìm ra ở census chunk 2.6 — đừng để phát hiện lại bằng một lỗi production.** Nhánh `scope=APP` của `POST /pricing-templates` cũng lấy credential từ `getActiveAccount()` (`app/api/iap-management/pricing-templates/route.ts:147`) để hỏi Apple theo `apple_app_id` rồi ghi `asc_account_id: creds.id` khi `ensureAppRegistered`. **Hôm nay điều đó AN TOÀN** vì danh sách app cũng đến từ account active, nên hai bên luôn khớp. **Bước (2) phá đúng sự khớp đó:** người dùng chọn app từ catalog của account B trong khi active vẫn là A ⇒ `getApp` hỏi Apple bằng credential A về một app của B (hỏng, hoặc tệ hơn là đăng ký app với `asc_account_id` SAI). Nên bước (2) và dòng 147 phải sửa CÙNG NHAU, không tách.
  4. Bỏ dòng giải thích của bước (ii) đi, vì lúc đó nó thành lời nói dối.

  ⚠ Đụng `asc-apps` là đụng ngoài module template. Fallback ở bước (2) không phải để chiều caller cũ (chỉ có một) mà để lời gọi thiếu tham số vẫn có nghĩa xác định thay vì 400 — cùng lập luận nhưng NGƯỢC kết luận với `POST /pricing-templates`, nơi fallback chính là ca ghi nhầm chỗ.

- [ ] [GOOGLE-account-scoped-template] **Google có Y HỆT vấn đề này và CHƯA đụng tới** — `google_iap_mgmt.pricing_templates` sao chép nguyên mô hình 2-scope của Apple (`CHECK (scope_type IN ('GLOBAL','APP'))`, 2 partial unique index, comment còn ghi *"matching the iap_mgmt p1.a pattern"*), và Default Template của Google cũng đang dùng CHUNG cho mọi `google_console_accounts`. ⚠ **Đừng port 1:1** (P8): `google_iap_mgmt.apps` có `google_console_account_id UUID NOT NULL REFERENCES … ` + `UNIQUE(account, package_name)` — Google account-scope ở tầng app CHẶT HƠN Apple (Apple chỉ có TEXT nullable, không FK), nên backfill của Google gần như miễn phí trong khi của Apple thì không. Cần census riêng trước khi thiết kế.

## From PR-2 (Team page + guarded user mutations)

- [ ] [PR-2] Replace `zodResolver(schema) as any` cast in team forms — `app/(dashboard)/store-submissions/config/team/*` — temporary workaround for RHF v7 + Zod v4 typing mismatch; revisit when react-hook-form v8 stable ships.
- [ ] [PR-2] Replace `window.confirm()` disable-user flow with shadcn `AlertDialog` — team page disable/demote actions — native confirm is ugly + not themeable; defer to UI polish pass after MVP.
- [ ] [PR-2] `countActiveManagers()` helper currently unused — `lib/store-submissions/queries/*` — keep for future use cases (reports, audit checks). Add `@internal` JSDoc so it isn't flagged as dead code by future sweeps.

## From PR-4 (App Registry CRUD) — discovered during tsc/test runs

- [ ] [PR-4] `countOpenTicketsForApp` in `lib/store-submissions/queries/apps.ts` silently returns 0 when `store_mgmt.tickets` is absent (42P01) so PR-4 can land before PR-5 — revisit after PR-5 lands and drop the fallback so a missing tickets table surfaces as a real DB error.
- [ ] [PR-4] `listApps` search path runs 2 separate queries against `apps.name/slug` and `app_aliases.alias_text`, then unions client-side — acceptable for the expected row counts (~100 apps, ~400 aliases) but should move to a Postgres function once we have >1k apps.
- [ ] [PR-4] `exportAppsCsvAction` reads apps/aliases/bindings/platforms/users in parallel but doesn't stream — fine for current scale, consider a streaming `text/csv` response once row count grows.
- [ ] [PR-4] Upgrade filter pills to Radix `DropdownMenu` — `components/store-submissions/apps/AppsClient.tsx` — native `<select>` overlay is functional but visually inconsistent with the rest of the shadcn ecosystem. Do in the UI polish pass post-MVP.
- [ ] [PR-4] URL-sync row-expansion state in App Registry — `components/store-submissions/apps/AppsClient.tsx` — refresh currently resets expanded rows, minor UX loss. Pattern: encode expanded IDs in `?expanded=id1,id2` and hydrate on mount.
- [ ] [PR-4-hotfix] Generate Supabase `Database` types — `lib/store-submissions/db.ts` — currently `StoreMgmtClient = SupabaseClient<any, any, 'store_mgmt'>` because we don't have schema types. Run `supabase gen types typescript --local > types/supabase.ts` and replace the first `any` with `Database`. Re-run after every migration.
- [ ] [infra] Set up ESLint config — repo root — `next lint` currently drops into an interactive "How would you like to configure ESLint?" prompt because there is no `.eslintrc*` / `eslint.config.*` file. Add a minimal `eslint.config.mjs` (Next.js strict preset) so CI + local verify can run it non-interactively.

## From PR-5 (Email Rules config) — scope / design notes

- [ ] [PR-5] Action surface collapsed from planned "8 Server Actions (CRUD per rule type)" to 2 (`saveRulesAction` + `rollbackRulesAction`) — bulk-replace fits the Save-button UX and keeps version snapshots trivially correct. If a future UX wants inline per-rule edits without a Save button, reintroduce per-rule actions but route them through `save_rules_tx` with a delta to preserve versioning. Surfaced for review.
- [ ] [PR-5] `types` deletion semantics — `save_rules_tx` / `rollback_rules_tx` in `supabase/migrations/20260419071718_store_mgmt_rules_rpcs.sql` upsert-by-slug and soft-deactivate missing types because `tickets.type_id ON DELETE RESTRICT` forbids hard delete. As a side effect, slug renames via the UI produce a new row + deactivate the old one (tickets keep pointing to the inactive row, classifier ignores it). If a UX design ever wants "rename slug" as a true rename, add a separate RPC that updates `types.slug` in place while the ticket FK stays intact.
- [ ] [PR-5] RPC integration tests — `supabase/migrations/20260419071718_store_mgmt_rules_rpcs.sql` is covered by action-level mock tests that simulate sqlerrm strings. Full DB-level race tests (two concurrent `save_rules_tx` calls against a real Postgres asserting exactly one version row was appended) live in an integration suite we haven't stood up yet — file a follow-up once a local supabase/docker test harness exists.
- [ ] [PR-5] Email Rules editor needs an explicit "Discard changes" affordance — mockup only shows "Save changes" + version badge. Browser reload works but an in-UI button is better UX; cover during Chunk 3.
- [ ] [PR-5 polish] VersionHistoryDialog full diff view (2-column snapshots side-by-side) — currently shows per-section counts + note. Upgrade to a textual diff in the polish pass. `getRuleVersionAction` already returns counts only; for full diff it must return the complete config_snapshot (or a new `getRuleVersionSnapshotAction` that does).
- [ ] [PR-5 polish] Save note input — `saveRulesInputSchema` already accepts an optional `note`, but Chunk 3.3 Save button doesn't prompt for one. Add a small "Save with note" affordance (secondary action or dialog with textarea) so Managers can annotate significant rule changes. The infra is already there end-to-end.
- [ ] [PR-5 polish] Add Toaster region-announce + `describedBy` wiring to the VERSION_CONFLICT toast so screen readers surface the Reload action. Sonner's default Toast is `role=status` which may not announce reliably for actionable errors.
- [ ] [PR-5 polish] "Discard changes" button surfaced by the dirty-state invariant — stub only. Matches the pre-existing TODO above; concrete UI is post-MVP.

## From PR-6 (Gmail OAuth Connect flow)

- [ ] [PR-6] Concurrent refresh protection for Gmail tokens — `lib/store-submissions/gmail/credentials.ts`. Two sync runs hitting `ensureFreshToken()` simultaneously could both call Google's refresh endpoint and race to write the new token. Add a Postgres advisory lock or a single-flight in-memory mutex in PR-7 before the sync loop ships. Intentionally deferred from PR-6 because the connect flow is single-user.
- [ ] [PR-6] Replace `window.confirm()` for disconnect with shadcn `AlertDialog` — `components/store-submissions/settings/SettingsClient.tsx`. Matches the PR-2 TODO for the team page disable flow; handle in the same UI polish pass.
- [ ] [PR-6] Client-component render tests — SettingsClient / TeamTable / etc. are untested at the render level because vitest is configured with `environment: 'node'` and no `@testing-library/react`/jsdom. Pure logic (`components/store-submissions/settings/helpers.ts`, action files) is covered. When enough UI bugs accumulate to justify the infra, add jsdom + React Testing Library and backfill render/interaction tests.
- [ ] [PR-6] Settings page Other Sections are placeholders only — Email retention, Gmail polling toggle, Realtime inbox toggle. Wire these up once the corresponding server behaviors exist (retention cron ships in PR-7+, polling toggle requires a `module_settings` row).
- [ ] [PR-6] `revokeTokens` is best-effort — failure is logged but not surfaced to the user, so a Google outage at disconnect time silently leaves a valid refresh_token hanging at Google side. DB row is deleted regardless. Acceptable for MVP; if leakage becomes a concern, add a retry queue or expose the revoke failure in the disconnect toast.

## From PR-7 (Gmail Sync Pipeline)

- [ ] [PR-7 polish] Audit all test files: replace `vi.clearAllMocks()` with `vi.resetAllMocks()` in `beforeEach` to prevent `mockImplementationOnce` / `mockReturnValueOnce` queue leak between tests. Found during 7.3.1 `sync.test.ts` debug — the "stats aggregation" test failed because a previous test's queued parser impls stayed in the queue. `clearAllMocks` only wipes call history, not the Once queues. Scope: ~30 test files in the codebase.
- [ ] [PR-7 polish] Replace synthetic MIME fixtures in `lib/store-submissions/gmail/__fixtures__/index.ts` with real anonymized samples from the shared mailbox (1 each: Apple, Google Play, Huawei, FB). Strip sensitive fields, use fake app names. Synthetic fixtures are good enough to exercise the parser's shape handling; real samples improve rule calibration accuracy.
- [ ] [PR-7 polish] Add `pg_cron` job (or a daily cleanup endpoint) to delete `store_mgmt.sync_logs` older than 90 days. Currently unbounded growth — ~288 rows/day from the every-5-min cron = ~100K rows/year. Small per-row; housekeeping avoids surprise later.
- [x] [PR-7] Sentry wiring for the sync endpoint — `app/api/store-submissions/sync/gmail/route.ts`. ✅ Resolved by PR-10d.1.2 (commit `085e422`): `instrumentation.ts` + `sentry.server.config.ts` boot Sentry; the 500-path now calls `Sentry.captureException(err, { tags: { component: 'gmail-sync', endpoint: 'cron-tick' } })`.
- [ ] [PR-7] Manual "Sync now" button in Settings page — trigger `POST /api/store-submissions/sync/gmail` via a Server Action, rate-limit 1/min per user. Emits `sync_method='MANUAL'` (value reserved in the `sync_logs` CHECK constraint, not yet produced by the cron path).

## PR-7 Post-Ship Polish (surfaced from 2026-04-21/22 production deployment)

- [x] [PR-polish] App Creator dialog UX — require ≥1 platform binding at creation OR auto-select all active platforms by default. Unbound app invisible to classifier (`loadAppsForPlatform` in `lib/store-submissions/queries/rules.ts` gates on `app_platform_bindings`). Silent miss harder to debug than form validation error. Ref: incident 2026-04-21/22 (Đấu Trường Chân Lý, Thiên Long Bát Bộ VNG, Top Eleven all needed manual `app_platform_bindings` INSERT to unblock classification). **Fixed 2026-04-23 — see PR-polish section below.**
- [ ] [ops] Migration deploy automation — investigate Supabase CLI + Railway auto-apply migrations on push. Manual "Path G" SQL-Editor workflow caused 2 production incidents during PR-7 deployment: sync lock migration (`20260420000000_store_mgmt_gmail_sync_lock.sql`, cron crashed with "try_acquire_sync_lock does not exist") + app RPCs migration (`20260419050324_store_mgmt_app_rpcs.sql`, App Registry UI broken with "create_app_tx does not exist"). Priority: raise from backlog.
- [x] [PR-7 polish] MIME parser charset handling — ✅ resolved by PR-14 (2026-05-01). Production corruption pattern `Da:%u TrF0a;ng ChC"n LC"` was NOT a charset issue. Root cause: parser's `raw.toString('ascii')` step (line 386-395 pre-fix) masked every byte with `& 0x7F`, false-positive-triggering QP decode on raw-UTF-8 bodies Apple mislabeled as `Content-Transfer-Encoding: QUOTED-PRINTABLE`. Byte `0xC4` (Đ lead) → `0x44` (D); `0xBD` (ý tail) → `0x3D` (`=`) followed by CRLF triggered the soft-break decoder; cascading corruption. Fix: byte-level decoder in `decodeQuotedPrintable(raw: Buffer, charset)` — walks bytes directly, only literal ASCII `0x3D` triggers escape parsing, bytes ≥ `0x80` pass through. Same 5-charset support retained (UTF-8 default + Latin-1 / cp1252 / us-ascii / UTF-16LE).
- [ ] [PR-7 polish] Apple subject pattern migration seed drift — production UI was updated with a pattern that strips the `(iOS)` suffix: `^Review of your (?<app_name>.+?) (?:\(iOS\) )?submission is complete\.$`. Update `supabase/migrations/20260101100200_store_mgmt_seed_apple_rules.sql` to match so future dev environments don't regress. Original seed lacked `(iOS)` handling → extracted app names included the suffix → app lookup miss.
- [ ] [rules calibration] Apple type rules populate — currently Apple emails stop at `UNCLASSIFIED_TYPE` (Steps 1–3 pass; Step 4 type keyword miss). Manager task via the Email Rules UI: populate type keywords for APPROVED outcomes (sample keywords from real bodies: "eligible for distribution", "review completed", "App Store Review"), REJECTED, PENDING states. Not a code bug — ongoing operational calibration as new Apple email templates surface. PR-8 ticket engine will still route UNCLASSIFIED_TYPE rows into the Unclassified bucket when it lands; type calibration is a forward-rolling improvement.

## PR-8 — Email Rule Engine wiring ✅ COMPLETED (2026-04-22)

Thin wire layer bridging classifier output → ticket engine. Stub engine returns ephemeral UUIDs; PR-9 drops in real engine behind same signature.

**Shipped:**
- `lib/store-submissions/tickets/types.ts` — `TicketableClassification` union + `isTicketableClassification` type-guard (single source of truth for wire pre-gate + engine defense-in-depth).
- `lib/store-submissions/tickets/engine-stub.ts` — ephemeral `randomUUID()` stub, throws `TicketEngineNotApplicableError` on non-ticketable status.
- `lib/store-submissions/tickets/wire.ts` — `associateEmailWithTicket(emailMessageId, classification)`, graceful errors, `[tickets-wire]` ERROR log prefix.
- `lib/store-submissions/gmail/sync.ts` — `insertEmailMessageRow` signature change (`Promise<void>` → `Promise<{id} | null>` with `.select('id').single()`), wire integration post-INSERT, **defensive try/catch** preventing cursor-wedge bug.
- +25 tests (14 tickets module + 11 sync wire integration).

**Deferred polish (low priority):**

- [ ] [PR-8 polish] `stats.tickets_associated` counter in `SyncStats` + `sync_logs` payload. Would touch the `sync_logs` schema (new column) — migration + `insertSyncLog` signature update. Derivable post-hoc via `SELECT count(*) FROM email_messages WHERE ticket_id IS NOT NULL AND processed_at > ?`. Punt unless observability actually needs it.
- [ ] [PR-8 polish] Wire success log at DEBUG level (currently silent on success, ERROR on failure). Would give per-message trace for production debugging but add ~2880 log lines/day on the every-5-min cron. Revisit only if a real debugging incident demands it; current `[tickets-wire]` ERROR coverage + `ticket_id IS NOT NULL` SQL queries are sufficient.

## PR-9 — Ticket Engine implementation ✅ COMPLETED (2026-04-23)

Replaced the PR-8 stub with a real transactional find-or-create + state machine + event log. Adapted spec's Prisma-flavored `db.$transaction` syntax to a Supabase-native PL/pgSQL RPC. Wire + sync unchanged — drop-in interface.

**Shipped (7 atomic sub-chunks + docs):**

| Sub-chunk | Commit | Scope |
|---|---|---|
| 9.1 | `cd96140` | Extend `FindOrCreateTicketOutput` (+3 optional fields) + new `TicketRow` type + spec banner + `docs/store-submissions/CURRENT-STATE.md` (new doc) |
| 9.2 | `ae3ed3e` | Migration `20260423000000_store_mgmt_ticket_engine_rpc.sql` — RPC `find_or_create_ticket_tx(p_classification JSONB, p_email_message_id UUID) RETURNS JSONB` + partial unique index `idx_store_mgmt_ticket_entries_email_idempotency` |
| 9.3 | `4a30cca` | Real `engine.ts` replacing deleted `engine-stub.ts` + 4 typed error classes + 15 engine tests |
| 9.4 | `4edc479` | Wire regression tests — pin error-agnostic catch + minimal-interface contract |
| 9.5 | `3b7a637` | State transition matrix (9 rows + resubmit) + terminal fall-through + novelty + idempotency tests (+17) |
| 9.6 | `e7c08b3` | Backfill migration `20260423100000_store_mgmt_backfill_ticket_id.sql` for PR-8-era NULL rows |
| 9.7 | `718f62d` | End-to-end pipeline integration tests — real wire + real engine, only Supabase mocked (+13) |
| 9.8 | this commit | Docs finalization (CURRENT-STATE.md, 04-ticket-engine.md §0, 03-email-rule-engine.md §14, TODO.md) |

**Test count:** 719 (pre-PR-9) → **785** (post-PR-9) = **+66 tests**.

**Key design adaptations from spec:**

- Spec uses Prisma (`db.$transaction`, `tx.$queryRaw`); implementation uses Supabase JS + PL/pgSQL RPC — see `04-ticket-engine.md` banner.
- Race strategy: `SELECT ... FOR UPDATE` → on miss `INSERT` → catch `unique_violation` → loop (3-iter budget). Partial unique index `idx_tickets_open_unique` is the canonical race arbiter.
- EMAIL entry idempotency: DB-enforced via partial unique index + `ON CONFLICT DO NOTHING` (vs app-level guard) — prevents dup EMAIL entries on sync retry.
- Deviation from §3.3: empty `type_payload` `{}` normalized to NULL at RPC extraction so audit trail stays signal-rich. Documented in migration header.

**Deferred polish (post-ship, low priority):**

- [ ] [PR-9 polish] `stats.tickets_associated` counter in `SyncStats` + `sync_logs` payload. Schema change — migration + `insertSyncLog` signature update. Derivable via `SELECT count(*) FROM email_messages WHERE ticket_id IS NOT NULL AND processed_at > ?`. Punt unless observability demands it.
- [ ] [PR-9 polish] Wire success log at DEBUG level (silent on success today). Would add ~2880 log lines/day on 5-min cron — revisit only on real debugging need.
- [x] [PR-9 polish] Surface `TicketEngineRaceError` + `TicketEngineNotFoundError` via Sentry. ✅ Resolved by PR-10d.1.2 (commit `085e422`): both engine errors are captured at the wire.ts swallowing boundary with `tags: { component: 'ticket-engine', phase: 'find-or-create' | 'update-link' }` so the graceful-null contract still holds while ops gets alerted.

**Post-deploy verification queries** in `20260423100000_..._backfill_ticket_id.sql` header comments (pre-apply preview + post-apply `without_ticket_id = 0` assertion).

## PR-polish — App Creator platform binding fix ✅ COMPLETED (2026-04-23)

Fixed: Dialog silently dropped platforms without `platform_ref`. Now checkbox
gate + submit validation require ≥1 platform selected. Edit-mode binding diff
reworked to `hadBinding vs wantsBinding` semantic (decoupled from ref presence).

**Root cause.** `AppDialog.collectBindingsForCreate()` filtered by
`platform_ref.trim() !== ''` instead of user intent. Classifier gates on
`platform_id` via `loadAppsForPlatform` — `platform_ref` is not read in the
visibility check. Apps created with empty refs got zero binding rows and
became invisible to the classifier → UNCLASSIFIED_APP.

**Shipped (5 atomic sub-chunks):**

| Sub-chunk | Scope |
|---|---|
| S.1 | `AppDialog.tsx` — `enabled` flag per platform, checkbox UI, disabled inputs, filter by `enabled` (not by ref) |
| S.2 | Submit guard (≥1 platform) + edit-mode rewrite (DELETE / CREATE / UPDATE via `hadBinding` × `wantsBinding` matrix) |
| S.3 | Extracted `components/store-submissions/apps/app-dialog-logic.ts` (pure helpers) + 11 unit tests; `AppDialog.handleSubmit` rewrote 100 → 55 LOC dispatcher |
| S.4 | Docs — this entry + `CURRENT-STATE.md` known-quirk entry |
| S.5 | `AppsClient.tsx` — "No platforms" red audit badge on list rows with zero bindings (defensive UX for historical unbound rows) |

**Test count:** 785 → **796** (+11 pure unit tests covering validation, create payload, and edit action plan including the 3 critical binding scenarios: DELETE, UPDATE-clear-ref, CREATE-without-ref).

**Zero infrastructure changes.** No migration, no RPC change, no API contract change — classifier and `create_app_tx` already handled nullable `platform_ref`; only the dialog UX needed fixing.

### Manual QA items (post-ship verification)

- [ ] Create app with Apple checkbox checked + ref blank → success, binding row created with `platform_ref = NULL`
- [ ] Edit existing app, uncheck a platform → binding row DELETE'd
- [ ] Edit existing app, clear a filled ref (checkbox stays checked) → binding row UPDATE'd with `platform_ref = NULL`
- [ ] Create app with zero platforms checked → toast error `"Please select at least one platform"`, no action call
- [ ] Disabled-input styling: unchecking a platform grays its ref + console URL inputs and blocks typing
- [ ] `<label>` wrapping row: clicking anywhere on a platform row toggles the checkbox (a11y pattern)
- [ ] `/config/apps` list: any app with zero bindings shows a red "No platforms" badge next to its `0 / 4` platform count

## PR-10c — Ticket user actions ✅ COMPLETED (2026-04-25)

Wire user-driven state transitions + comment + reject-reason flows on top of the email-driven engine shipped in PR-9. Adds 7 PL/pgSQL `*_tx` RPCs (spec §7), a TypeScript dispatcher with `executeTicketAction(actor, ticketId, action)`, role-gated UI footer + composer in the inbox detail panel, and timeline cards for the new entry types. Builds on PR-10a (list) + PR-10b (detail panel shell).

**Shipped (8 atomic sub-chunks):**

| Sub-chunk | Commit | Scope |
|---|---|---|
| 10c.1.1 | `6dc8a6c` | `state-machine.ts` pure helpers (action → next state derivation) + 46 tests |
| 10c.1.2 | `ee27ef1` | `user-actions.ts` dispatcher + `tickets/auth.ts` per-action permission matrix + 46 tests |
| 10c.1.3 | `1a58363` | Migration `20260424000000_store_mgmt_user_actions_rpcs.sql` — 7 RPCs (archive / follow_up / mark_done / unarchive / add_comment / edit_comment / add_reject_reason) |
| 10c.1.4 | `fc7c18c` | User-actions integration tests (Supabase mocked, RPC error mapping covered) +24 |
| 10c.2 | `b970517` | Inbox state-transition actions UI — 4 footer buttons + 10s Undo toast for ARCHIVE +20 |
| 10c.3.1 | `0819dbc` | `CommentForm` (always visible) + reject-reason composer (toggle-revealed) +10 |
| 10c.3.2 | `0257b83` | `CommentEntryCard` + `RejectReasonEntryCard` timeline renderers + `EditCommentForm` wired for own comments + trigger keyword fix (`'user' → 'user_action'` per spec §7.3) + currentUserId threaded 4 layers |
| 10c.3.2.2 | `b833172` | RTL infra (`@vitejs/plugin-react`, `jsdom`, `jest-dom`, vitest setupFile) + 10 timeline component tests |

**Test count:** 827 (pre-PR-10c) → **983** (post-PR-10c) = **+156 tests**.

**7 user actions production-ready:** archive / follow_up / mark_done / unarchive / add_comment / edit_comment / add_reject_reason. Authorization matrix matches spec §7.2 (DEV/MANAGER permissive, VIEWER read-only, UNARCHIVE Manager-only).

**Critical fix:** trigger keyword mismatch between RPC migration (`metadata.trigger='user_action'`, spec-canonical) and the timeline renderer (`=== 'user'`) — would have surfaced post-deploy as STATE_CHANGE entries falling through to UnknownEntryCard. Caught + fixed in 10c.3.2 with regression test in 10c.3.2.2.

**Foundation unblocked by 10c.3.2.2:** RTL component-test infra now in place. Future timeline / form / detail-panel tests no longer need infra setup — drop in `// @vitest-environment jsdom` directive and write.

**Pending after this commit:**

- [ ] Path G — apply migration `20260424000000_store_mgmt_user_actions_rpcs.sql` via Supabase SQL Editor (production)
- [ ] Manual QA scenarios: 4 state buttons / 10s Undo / comment add+edit ownership / reject reason / timeline render of all 5 entry types / VIEWER hides actions / DEV-MANAGER full functionality

## PR-10d — Polish + Observability ✅ COMPLETED (2026-04-25)

Production observability + UX polish. Wires Sentry SDK end-to-end and adds keyboard navigation. Closes the PR-7 + PR-9 deferred Sentry debt.

**Shipped (4 sub-chunks):**

| Sub-chunk | Commit | Scope |
|---|---|---|
| 10d.1.1 | `0fdaf92` | Sentry init — `instrumentation.ts` + `sentry.server.config.ts` + `sentry.edge.config.ts` + `instrumentation-client.ts` (modern v10 pattern, replaces deprecated `sentry.client.config.ts`) + `withSentryConfig` wrap in `next.config.mjs` + `.env.example` additions |
| 10d.1.2 | `085e422` | `Sentry.captureException` in 3 production error paths — gmail-sync 500 fallback, ticket-engine wire.ts (both catch sites), inbox-actions unmapped DB_ERROR. `Sentry.setUser` auto-binds via `guardDevOrManager`. Resolves TODO.md PR-7 + PR-9 debt. |
| 10d.1.3 | `83dee62` | Route-level error boundary `app/(dashboard)/store-submissions/inbox/error.tsx` + root-layout fallback `app/global-error.tsx`. Resolves the SDK's `global-error.js` warning. |
| 10d.2 | `f73355d` | j/k row navigation + Enter to open via `react-hotkeys-hook` v5. `focusedIndex` state with `ticketsKey`-stable reset. Desktop-only hint strip. Bundle 11 → 13.7 kB. |

**Tag taxonomy established:**
- `component`: `gmail-sync` | `ticket-engine` | `inbox-actions` | `inbox-error-boundary` | `global-error-boundary`
- Subcontext: `phase` | `endpoint` | `action`
- User context auto-bound via `guardDevOrManager` (id + role; email omitted as PII)
- PII filter in `sentry.server.config.ts#beforeSend` redacts `body` / `email` / `content` keys (Apple/Google reviewer text never transits)

**Capture scope discipline:**
- DO capture: 500 errors, race conditions, unmapped DB failures, swallowing-boundary catches
- DON'T capture: typed business errors (state guards, ownership checks, validation) — would flood Sentry with normal flow

**Test count:** 983 unchanged (10d.2 logic too trivial to merit unit tests; E2E is the value-adding test type and was deferred per scope).

**Pending:** push 4 commits to `origin/main`.

## Post-PR-10 — Reclassify feature ✅ COMPLETED in PR-11 (2026-04-25)

Shipped in 7 sub-chunks. See `docs/store-submissions/CURRENT-STATE.md`
"PR-11 — HTML Parsing + Reclassify" section + commits
`cb4480c..130f35e + 11.7-docs`. Original use cases all addressed
(UNCLASSIFIED_APP → CLASSIFIED after App Registry add, UNCLASSIFIED_TYPE
→ CLASSIFIED after type seed, DROPPED via sender re-resolve).

**Architecture**: TS classifier + SQL atomic swap (RPC `reclassify_email_tx`)
— see PR-11.5 commit `f00cac7` rationale. Spec §5.2 ticket-level
reclassify (move all emails of a ticket via merge) remains future work,
tracked under "PR-11 deferred items" below.

## PR-11 — HTML Parsing + Reclassify ✅ COMPLETED (2026-04-25)

7 sub-chunks. See `docs/store-submissions/CURRENT-STATE.md` for full detail.

**Test count:** 983 (pre-PR-11) → **1036** (post-PR-11) = **+53 tests**.

**3 migrations pending Path G** (apply in order):

1. `20260425000000_store_mgmt_email_extracted_payload.sql` — add JSONB column + GIN index
2. `20260425000001_store_mgmt_seed_apple_ppo_type.sql` — PPO type seed
3. `20260425000002_store_mgmt_reclassify_rpc.sql` — `reclassify_email_tx` RPC

### Deferred from PR-11 (post-MVP)

- [ ] [PR-11 polish] **Real PL/pgSQL execution tests for `reclassify_email_tx`** — current 19 tests in `app/(dashboard)/store-submissions/inbox/reclassify-actions.test.ts` mock the RPC at the Server Action boundary. End-to-end against a migration-applied DB (with `find_or_create_ticket_tx` reuse paths exercised) requires the same Supabase local docker harness that PR-5's TODO line 25 requested. File together when the harness lands. Manual QA Path G validates production in the meantime.
- [ ] [PR-13+ polish] **Multi-platform HTML extractors** — `extractGoogle` / `extractHuawei` / `extractFacebook`. Need real `.eml` samples first. Current `lib/store-submissions/gmail/html-extractor.ts` is Apple-coupled by name. Shared `ExtractedPayload` shape is the contract. Activate when prod sees enough volume from those platforms to need structured extraction. **Backfill button (`backfill-actions.ts`) is also Apple-only by `appleEmails` SQL filter — multi-platform extractor + multi-platform backfill ship together when each platform's extractor lands.**
- [x] [PR-11 polish] **Rejected items HTML parser** — ✅ Resolved by PR-12.1+12.2 (commit `b1060e8`): `extractApple(html, subject?)` rejection branch + `outcome` audit flag + `items` rename + IAE optional count. 4 rejection `.eml` fixtures captured (App Version / IAE / CPP / PPO) + 8 new extractor tests.
- [ ] [PR-11 polish] **Auto-archive empty old tickets** — when reclassify moves the last email out of an Unclassified bucket, the old ticket may end up with zero emails. Currently left for Manager cleanup. Could ship a "sweep empty buckets" cron job or a "Empty bucket" badge on the inbox list. Decide based on real Manager workflow feedback.
- [ ] [PR-11 polish] **`UnifiedClassificationResult` typing cleanup** — `lib/store-submissions/gmail/sync.ts` and `app/(dashboard)/store-submissions/inbox/reclassify-actions.ts` both relax to `Record<string, unknown>` for the persisted classification because the classifier's `ErrorCode` union doesn't include sync-layer concerns (`NO_RULES`, `NO_SENDER_MATCH` from non-classifier paths). Unify into a `PersistedClassification` type that's a superset of `ClassificationResult`. Cosmetic.
- [ ] [PR-13+] **Spec §5.2 ticket-level reclassify (merge)** — move all emails of a ticket via Manager UI; if the new grouping key collides with an open ticket, MERGE entries + emails into the conflict ticket and delete the source. PR-11 ships email-level reclassify (the operational use case); ticket-level merge is the design described in `docs/store-submissions/04-ticket-engine.md` §5.2 lines 589-676.

## PR-12 — Apple rejection parser + Backfill button MANAGER ✅ COMPLETED (2026-04-27)

4 commits (down from 7-chunk plan via subsume discipline):

| Commit | Scope |
|---|---|
| `b1060e8` | **PR-12.1+12.2 bundle** — `extractApple(html, subject?)` rejection branch + `outcome` audit flag + `items` rename + IAE optional `(N)` count + `extractIdAndName` (Submission ID + App Name parse) + 4 rejection `.eml` fixtures + restructured `html-extractor.test.ts` (4+4+4+6 tests). Sync wire threading + classifier audit comment subsumed (12.3 + 12.4 absorbed). |
| `f4188db` | **PR-12.5** — `lib/store-submissions/reclassify/core.ts` extraction (~200 lines) + `backfill-actions.ts` (~370 lines) + `BackfillButtons` UI component. Sentry `backfill-action` taxonomy. |
| `00419bc` | **PR-12.6** — 8 backfill action tests (single happy + bulk happy + bulk empty + VIEWER × 2 + per-row resilience + Apple-only filter × 2). |
| this commit | **PR-12.7** — Docs finalization. |

**Test count:** 1036 (pre-PR-12) → **1053** (post-PR-12) = **+17 tests** (8 extractor + 8 backfill action + 1 IAE-no-parens, accounting for restructure).

**No migrations** — PR-12 is application-layer only. The shape rename
(`accepted_items` → `items`) reuses the existing JSONB column; the
Postgres `COMMENT ON COLUMN` in
`20260425000000_store_mgmt_email_extracted_payload.sql:20` is left
stale per the no-down-migrations rule and tracked under PR-13+ schema
cleanup below.

**Production state:** 14 legacy UNCLASSIFIED rows pre-PR-11.3 carry
`extracted_payload IS NULL`; 0 Apple emails arrived post-2026-04-25
deploy so the PR-11.3 wire was untested in production. PR-12 self-
verified via 8 fixtures (4 acceptance + 4 rejection); production
verification ships via the **Backfill 1 row (test)** button — run that
first, verify Sentry breadcrumbs, then **Backfill all** for the bulk.

### Deferred from PR-12 (post-ship, low priority)

- [ ] [PR-13+ schema cleanup] **Refresh `COMMENT ON COLUMN extracted_payload`** — `supabase/migrations/20260425000000_store_mgmt_email_extracted_payload.sql:20` still reads `Shape: { accepted_items: AcceptedItem[] }` after the PR-12 rename. Postgres metadata comment, not enforced. Refresh on the next forward migration that touches the column.
- [ ] [PR-13+ polish] **Sentry breadcrumb cap formalization for backfill** — current 4-stage × 14-row max = 56 breadcrumbs (well under Sentry default 100). Multi-platform expansion may push past — add explicit `cap-at-first-N + summary` pattern in `backfill-actions.ts` when batch sizes grow past ~20 candidates.
- [ ] [PR-13+ extraction] **Per-row backfill affordance in EmailEntryCard** — `backfillSingleEmailAction(emailId)` is exported and tested but currently unused by UI (the Manager Unclassified banner uses bulk-with-limit:1). When ticket detail panel needs a "re-extract this specific email" affordance (e.g. a Manager investigating a specific email's outcome), wire the per-email button via `entry.email_message_id`. Pattern matches the existing `ReclassifyEmailButton` in `TicketEntriesTimeline.tsx`.
- [ ] [PR-13+ test infra] **Vitest cold-start flake** — observed 1052/1053 once on first full suite run after `backfill-actions.test.ts` added (3 consecutive subsequent runs all 1053). Not specific to backfill tests; likely a vitest module loading race during cold start. If it recurs, investigate `vi.mock` hoisting timing or test file ordering.
- [ ] [PR-13+ polish] **Multi-platform backfill expansion** — `backfill-actions.ts` is Apple-only by `appleEmails` SQL filter. Ships together with multi-platform HTML extractors (see PR-13+ multi-platform note above).

## PR-13 — Outcome filter dimension separation ✅ COMPLETED (2026-04-30)

4 commits (single session, ~4h):

| Commit | Scope |
|---|---|
| `d556fc6` | **PR-13.1** — Backend: `outcomeFilterSchema` (enum ∪ `'none'` literal) threaded into `ticketsQuerySchema` + `listTickets` predicate (`'none'` → `.is('latest_outcome', null)`, enum → `.eq`) + URL parser via `firstOf` + 8 tests (4 schema/parser + 4 query). Backward compat verified — existing `?state=APPROVED` bookmarks parse and filter identically. |
| `346785a` | **PR-13.2** — UI tab consolidation + chip row: drop standalone Rejected tab (was conflated with outcome dimension, masked Issue 2) + 5-tab final (Open/Approved/Done/Archived/Unclassified) + 5-chip outcome row (All/Approve/Reject/In review/No outcome) + visual hierarchy (tabs underline / chips pill rounded-full) + `aria-pressed` + chip-survives-tab-switch via `baseParams.scalarKeys` + chips hidden on Unclassified tab. Bundle inbox 15.1 → 15.2 kB (+0.1 kB). |
| `41f0a84` | **PR-13.3** — Empty-state refresh: pure helper extraction (`lib/store-submissions/inbox/empty-message.ts`) + Hybrid Option C decision tree (5 branches: hasOtherFilters → generic; unclassified → triage; outcome='none' → "All {tab} have outcome assigned"; outcome=enum → "No {tab} with outcome '{label}'. Try clearing chip filter."; default → tab-specific) + `hasOtherFilters` vs `hasActiveFilters` split (different consumers, different semantics — empty-message branching vs Clear-button surface) + 5 tests. Net InboxClient -24 lines. |
| this commit | **PR-13.4** — Docs (CURRENT-STATE.md PR-13 milestone + 03-email-rule-engine.md 3-dimension paragraph + 04-ticket-engine.md PR-13 §0 subsection + this entry). |

**Test count:** 1053 (pre-PR-13) → **1067** (post-PR-13) = **+14 tests** cumulative.

**Bundle inbox:** 15.1 → **15.4 kB** (+0.3 kB across 4 commits, well under +0.5–1 kB target).

**No migrations** — PR-13 is application-layer only (read-side UI affordance + URL/query schema). Engine, RPC, and `latest_outcome` flow unchanged.

**Issue 2 resolved.** PR-12 backfill populated `tickets.latest_outcome` at production scale for the first time, exposing a pre-existing UI dimension misalignment: tickets with `state=IN_REVIEW` + `latest_outcome=APPROVED` showed "Approve" in the Outcome column but were filtered out of the "Approve" tab (which queried `state=APPROVED`). Not a regression — exposure surfaced by Q1 Option A discipline correctly populating the dimension. Fix surfaces outcome as first-class chip refinement WITHIN state tabs, with clear 3-dimension model documented (state / latest_outcome / classification_status).

### Risk flags bumped from PR-13 close

- [x] [PR-14] **Issue 1 — UTF-8 body preview** — ✅ resolved by PR-14 (2026-05-01). Surfaced from PR-12 close, scoped under PR-14 after PR-13 shipped. Hypothesis flipped multiple times during investigation (charset → Apple-side broken → parser bug); root cause was the `raw.toString('ascii')` byte-mask step in `decodeQuotedPrintable`. Fix shipped + 14 functional production rows backfilled via the maintenance banner.
- [ ] [PR-18+] **Per-row backfill affordance in EmailEntryCard** — see PR-12 deferred items (line 264). Same scope.
- [ ] [PR-18+] **Multi-platform extractor expansion** — see PR-11/PR-12 deferred items.
- [ ] [PR-18+] **Migration COMMENT refresh** + **Sentry breadcrumb cap formalization** + **Vitest cold-start flake** + **Gmail OAuth token resilience** — all infra cleanup deferred from PR-12.
- [ ] [PR-18+] **Spec §5.2 ticket-level merge** — see PR-11 deferred items (line 231).

## PR-14 — Byte-level QP decoder + corrupt-payload backfill ✅ COMPLETED (2026-05-01)

5 commits (single multi-step session, ~5h with investigation):

| Commit | Scope |
|---|---|
| `d20c898` | **PR-14.1+14.2 bundle** — Byte-level QP decoder rewrite. Replaced `decodeQuotedPrintable(input: string, charset)` with `(raw: Buffer, charset)` byte walker. `decodePartBody` no longer runs `raw.toString('ascii')` (the `& 0x7F` mask step that turned UTF-8 bytes `0xC4 0x90` into `D \u0010`, etc.). New synthetic fixture `edgeAppleMislabelUtf8` mirrors TICKET-10009 wire shape (multipart/alternative, both parts CTE: QUOTED-PRINTABLE, text/plain raw UTF-8, text/html mixed `=3D` + raw UTF-8). 4-layer diagnostic block (Layer 1 RFC 2047 continuation-line `.skip()`, Layers 2-4 unskipped). +3 tests. |
| `66223da` | **PR-14.3** — Charset coverage fixtures + tests. Chinese (`彈彈英雄`, 3-byte UTF-8), Japanese mixed scripts (`テスト『日本語アプリ』ゲーム`), emoji (`🎮 Crystal Quest 🐉`, 4-byte → UTF-16 surrogate pair pinned `\uD83C\uDFAE`), mixed-encoding (genuine `=C3=A9` QP escape + raw UTF-8 `0xC3 0xA9` decode identically to `é`). +4 tests. |
| `2ee80e8` | **PR-14.4** — `backfillCorruptPayloadAction` + maintenance banner D2. Apple-only re-fetch + re-parse + re-extract pipeline targeting rows whose `extracted_payload->>'app_name'` or `raw_body_text` carry control-byte residue. PostgREST `.or()` regex filter on `[\x01-\x08\x0B\x0C\x0E-\x1F]` (verify-then-fallback per Decision 3; RPC fallback documented inline). MANAGER-only Sentry tag `variant: 'corrupt-payload'`. New `lib/store-submissions/backfill/core.ts` extraction (mirrors PR-12.5 `reclassify/core.ts` precedent); `backfillOne` now writes BOTH `raw_body_text` + `extracted_payload`, so NULL-payload backfill incidentally repairs any byte-mask corruption in the same row. New `lib/store-submissions/queries/corrupt-payload.ts` count probe (MANAGER-only, head:true, gracefully degrades to 0). New `CorruptPayloadBanner` subcomponent rendering above state tabs (D2 override of locked Decision 4 D1 — corrupt rows are CLASSIFIED status, not Unclassified, so D1 would have hidden the action). +5 tests. |
| this commit | **PR-14.5** — Docs (CURRENT-STATE.md PR-14 milestone + 02-gmail-sync.md §4.3.1 MIME body decode subsection + this entry). Cleanup verification (diagnose-message diagnostic API route absent, no stale scripts). |

**Test count:** 1067 (pre-PR-14) → **1079** (post-PR-14) = **+12 tests** cumulative. 1 deferred `it.skip()` placeholder for Layer 1 RFC 2047 continuation-line bug.

**Bundle inbox:** minor increase from new `CorruptPayloadBanner` subcomponent + `Wrench` icon import.

**No migrations** — PR-14 is application-layer only (parser fix + new Server Action + UI banner + new query module). No schema change. Forward-only fix; new emails post-deploy parse correctly via the byte-level decoder.

**Production scope at fix time** — 14 functional rows (`extracted_payload IS NOT NULL`, `classification_status != 'DROPPED'`) across 4 distinct apps (Đấu Trường Chân Lý / TFT VN, LMHT: Tốc Chiến / LoL Wild Rift VN, 彈彈英雄, 創世紀戰M：阿修羅計畫). 189 additional rows hit the regex but were DROPPED — left alone per Decision 2 (functional impact only).

### Investigation discipline (4 hypothesis pivots earned by data)

1. **Synthetic real-QP fixture passed** — proved parser handles real QP correctly; bug had to be elsewhere.
2. **Layer 1 RFC 2047 continuation-line bug discovered** — real but orthogonal to production symptom (subjects render fine in prod). Parked PR-18+.
3. **Production SQL diagnostic confirmed BOTH `raw_body_text` and `extracted_payload` garbled** — same parser path; parser was the culprit.
4. **Diagnostic API route revealed Apple's wire bytes are correct UTF-8** — parser corrupts them via `raw.toString('ascii')` byte-mask. Synthetic fixture had used real QP encoding; real Apple emails ship raw UTF-8 with the QP header lying. Mislabel was the missing fixture variant.

The diagnostic API route (`GET /api/store-submissions/diagnose-message?id=…`) was deleted before any commit — investigation ephemeral, not shipped.

### Decision overrides (vs locked plan)

- **Banner placement: D2 over D1.** Locked plan was D1 (3rd button in Unclassified-tab banner). Codebase grounding revealed corrupt rows are CLASSIFIED status (Open/Done tabs), not Unclassified. D1 would have hidden the action behind a tab where the rows don't appear. D2 ships a separate amber maintenance banner above state tabs, visible on every tab when count > 0.
- **`.or()` regex over RPC migration (Decision 3 = verify-then-fallback).** Direct PostgREST `.or()` syntax shipped; RPC fallback documented inline for hot-pivot if production rejects.

### Open follow-ups (PR-18+)

- [ ] [PR-18+] **Layer 1 — RFC 2047 subject continuation-line whitespace** — `decodeRfc2047` in `parser.ts` runs the per-word decode before the `\?=\s+=\?` collapse pass; encoded-word markers are gone by the time the collapse runs and orphan whitespace leaks (e.g. `Chơi Nga y Game` instead of `Chơi Ngay Game`). Real bug confirmed by Layer 1 diagnostic but separate decoder, separate symptom from the production-reported PR-14 corruption. Tracked as `it.skip()` placeholder in `parser.test.ts` with fix-pointer comment.
- [ ] [PR-14 manual QA] **PostgREST `.or()` regex runtime validation** — verify the candidate filter and count probe work in production. Hot-pivot to the RPC fallback in `app/(dashboard)/store-submissions/inbox/backfill-corrupt-actions.ts` if rejected.
- [ ] [PR-18+] **Auto-mark-done APPROVED logic** + **duplicate ticket entries bug** — surfaced in earlier PR-12/13 close; not addressed in PR-14.

## PR-15 — Slug generator non-ASCII support ✅ COMPLETED (2026-05-01)

3 commits (single multi-step session, ~2.5h):

| Commit | Scope |
|---|---|
| `e0e3922` | **PR-15.2** — `generateSlugFromName` hash fallback (FNV-1a 32-bit pure TS, `app-<8hex>` format) for inputs with fewer than `SLUG_MIN_MEANINGFUL_LENGTH=3` ASCII alphanumerics. `tryGenerateAsciiSlug` exported helper returns `string \| null` so the type-slug auto-derive in `safeSlugFromName` (TypesTable) preserves `""` semantic instead of receiving an unhelpful hash. +10 alias-logic tests (CJK, single-`m` degenerate, TFT boundary, VN below-threshold, emoji, pure-punct, lone combining marks, determinism, distinctness, threshold const). +2 helpers tests locking the type-slug divergence. +1 createAppAction integration test (replaced the obsolete "rejects on InvalidSlugError" test). `Node crypto` deliberately avoided — `alias-logic.ts` is imported by AppDialog (Client Component); FNV-1a is client-bundle-safe, async Web Crypto would not fit the synchronous signature. |
| `fb04521` | **PR-15.3** — AppDialog slug override input field (create-mode only; edit-mode keeps "won't change on rename" helper text unchanged). `slugTouched` state + per-tick `setForm(p => p.slug === auto ? p : ...)` guard prevent useEffect → setForm infinite loop in React strict mode. Contextual helper text (default / hash-fallback hint with `tantanyingxiong` example / red error). `aria-invalid` + `aria-describedby` a11y. Submit disabled on validation error. `slugSchema` extracted to `lib/store-submissions/schemas/slug.ts` (only `zod` dep) so client bundle no longer pulls `re2-wasm` transitively via `validateAliasRegex` in `schemas/app.ts`; `app.ts` re-exports for unchanged server-side imports — same trap documented in CLAUDE.md's lessons-learned. Mode-aware `validateFormState(form, mode)` skips slug check in edit mode. +7 app-dialog-logic tests. |
| this commit | **PR-15.4** — Docs (CURRENT-STATE.md PR-15 milestone + features-table row + PR-timeline row + this entry). Retag stale `[PR-15+]` deferral markers → `[PR-16+]` across CURRENT-STATE.md and TODO.md. |

**Test count:** 1079 (pre-PR-15) → **1096** (post-PR-15) = **+17 tests** cumulative across 15.2 +13 + 15.3 +7, minus 1 obsolete throw test deleted in 15.2 (the "rejects on InvalidSlugError" path no longer fires for non-empty input).

**Bundle (`/store-submissions/config/apps`):** +0.5 kB for the slug input + slim `slugSchema` module. FNV-1a 32-bit adds zero bytes vs the SHA-256 alternative (no Node `crypto` polyfill needed).

**No migrations** — PR-15 is application-layer only. No DB column change. All existing slugs preserved unchanged; new apps post-deploy use the new logic.

**Production scope at fix time** — Manager blocked from registering 12+ apps in the `UNCLASSIFIED_APP` bucket whose UTF-8 names PR-14 had just repaired. Affected apps: 彈彈英雄, 創世紀戰M：阿修羅計畫, plus other Asian-language titles in the VNG portfolio.

### Hidden bug surfaced + bonus fix

`創世紀戰M：阿修羅計畫` did not throw — the lone Latin "M" survived
normalization and produced slug `"m"`. Passed `slugSchema` (min 1
char) but semantically useless and likely to collide. The
`SLUG_MIN_MEANINGFUL_LENGTH=3` threshold catches this case alongside
the empty-output cases the user originally reported.

### Architecture decisions

- **FNV-1a 32-bit pure TS over Node `crypto.createHash` SHA-256.** Required for client-bundle compat — `alias-logic.ts` is imported by `AppDialog.tsx` for live slug preview, and Next.js 14 doesn't auto-polyfill Node's `crypto`. 4B output space is plenty for ~200 apps; UNIQUE constraint catches collisions.
- **`tryGenerateAsciiSlug` helper extraction.** Two callers, two semantics: app-registry wants hash fallback to unblock CJK; type-slug auto-derive in TypesTable wants `""` so Manager picks meaningful short codes (`app`, `iae`, `ipa`). Same pattern as PR-12.5 (`reclassify/core.ts`) and PR-14.4 (`backfill/core.ts`).
- **`slugSchema` module split.** Avoids pulling `re2-wasm` into the client bundle when AppDialog validates slug input. Server-side imports unchanged via re-export. Mirrors the `alias-logic.ts` ↔ `alias-conflicts.ts` split documented in CLAUDE.md lessons-learned.
- **Mode-aware `validateFormState(form, mode)`.** Edit mode skips slug check (read-only on rename per existing UX contract). Save button stays unblocked even if edit-mode FormState defensively carries an invalid slug value.
- **Threshold = 3 ASCII alphanumerics.** Catches `"m"` degenerates and 2-char abbreviations while preserving 3-letter acronyms (`TFT`, `VNG`, `LOL`). Exported as constant for future tuning if Manager UAT signals.

### Open follow-ups (PR-18+)

- [ ] [PR-18+] **Threshold tuning** — `SLUG_MIN_MEANINGFUL_LENGTH=3` conservatively rejects 2-char abbreviations like `"VN"`. If Manager UAT signals this feels wrong, lower to 2; hash fallback still catches CJK / emoji / pure-punctuation. Wait for production signal before tuning.
- [ ] [PR-18+] **CSV bulk-import slug override** — `importAppsCsvAction` derives slug from `name` only (no manual override path). With PR-15.2's hash fallback the action no longer fails on CJK names. If Managers want readable slugs for bulk-imported CJK apps, add a `slug` column to the CSV template + parser. Defer until UAT surfaces the need.

## PR-15.5 — Stale-EMAIL filter post-reclassify ✅ COMPLETED (2026-05-01)

Hotfix between PR-15 (slug generator) and PR-16 (auto-mark-done design). 1 commit. Surfaced from production immediately after PR-15 unblocked CJK app registration: Manager reclassified Play Together VNG email out of TICKET-10000 (UNCLASSIFIED_APP catch-all), but the same email kept rendering in both TICKET-10000 and the new classified ticket.

**Root cause** — intentional data divergence missed by UI:
- `reclassify_email_tx` deliberately leaves the original EMAIL `ticket_entry` on the old ticket as audit history per CLAUDE.md invariant #2 (ticket_entries append-only). RPC explicitly cites this in its own comment.
- `email_messages.ticket_id` is the single source of truth for "where this email currently lives"; it gets correctly updated to the new ticket.
- UI queries (`getTicketWithEntries`, `listTickets` firstEmail subquery) read `ticket_entries` by `ticket_id` only — never joined `email_messages.ticket_id` to filter.
- Stale EMAIL entry surfaced on TICKET-10000 detail panel + as the inbox card's `first_email` preview, alongside the (correct) new EMAIL entry on the destination ticket.

**Fix** — Option A (UI filter at read time):
- PostgREST embed `email_message:email_messages!email_message_id (ticket_id)` pulls each EMAIL entry's current `ticket_id` alongside the entry data.
- JS filter: hide `EMAIL` entries whose embedded current `ticket_id` doesn't match the rendering ticket. STATE_CHANGE / COMMENT / PAYLOAD_ADDED entries unaffected.
- The STATE_CHANGE `'reclassify_out'` audit annotation on the old ticket stays visible — Manager can see what happened.

**Files**:
- `lib/store-submissions/queries/tickets.ts`:
  * `getTicketWithEntries`: PostgREST embed + `visibleRawEntries` filter (lines 605-612, 645-660)
  * `listTickets` firstEmail subquery: PostgREST embed (lines 425-435) + filter inside the first-write-wins map loop (lines 491-510). Filter applies BEFORE the map check so the next-oldest CURRENT EMAIL becomes the preview, not the next-oldest stale.
- `lib/store-submissions/queries/tickets.test.ts`:
  * +5 tests:
    - 3 detail-panel cases: stale hidden + STATE_CHANGE preserved; DROPPED reclassify (ticket_id=null) hidden; normal-case regression
    - 2 listTickets firstEmail cases: skip stale to pick next current; all-stale → first_email=null
  * Updated 2 pre-existing tests + the `makeHydrationMocks` helper signature to include `email_message: { ticket_id }` in fixtures (otherwise filter sees `undefined` and hides them too).

**Discarded alternatives**:
- UPDATE/DELETE old EMAIL entry — violates invariant #2 (append-only); RPC's own comment cites this.
- New `superseded_by_ticket_id` column on ticket_entries — schema-change overkill; column UPDATE softens but doesn't escape the append-only intent.
- Visual marker on stale entries — still shows duplicate content, just labeled.
- Auto-archive ticket on last-EMAIL-exit — bigger scope, deferred PR-18+ as standalone follow-up.

**No backfill, no migration, no RPC change.** Filter applies at read time and retroactively hides existing stale entries on next page load.

**Test count**: 1096 → **1101** (+5).
**Bundle**: zero (filter logic + query string change).

### Open follow-ups (PR-18+)

- [ ] [PR-18+] **Auto-archive ticket on last-EMAIL-exit** — `reclassify_email_tx` could detect when the old ticket has zero current EMAIL entries remaining post-reclassify and atomically transition `state` to `ARCHIVED` with `resolution_type='SYSTEM_RECLASSIFIED'`. Empty TICKET-10000 then disappears from inbox listing entirely instead of showing as a card with no preview. RPC change required; state-machine semantics + backfill discussion needed.
- [ ] [PR-18+] **"Reclassified from TICKET-X" annotation on destination ticket** — mirror of the `STATE_CHANGE 'reclassify_out'` audit entry. `find_or_create_ticket_tx` could detect reclassify-source via a parameter and label the new ticket's transition entry as `'reclassify_in'` with source ticket's display_id for full bidirectional audit visibility.
- [ ] [PR-18+] **`entry_count` semantics review** — inbox card's `entry_count` counts ALL `ticket_entries` rows. After PR-15.5 a ticket may show `entry_count: 5` while `first_email: null` (5 = 1 stale EMAIL + 4 STATE_CHANGE). Count and preview disagree visually. Either rename the count to "events" or apply the same stale-EMAIL filter to the count. Worth Manager UAT signal first.

## PR-17 — Inbox UI/UX optimizations + Ticket detail polish ✅ COMPLETED (2026-05-03 / 2026-05-04)

2 sub-PRs + 1 hotfix shipped across 2 days. 3 commits, 0 migrations (UI + cursor + helper changes only). Manager UAT MV1-MV6 verified all-green; MV6 surfaced PR-17.2.5 hotfix via image evidence.

| Commit | Sub-PR | Scope |
|---|---|---|
| `d1fc8f3` | **PR-17.1** | Inbox UX optimizations bundle (5 sub-chunks): date format util `format-date.ts` ABSOLUTE `dd/MM/yyyy HH:mm` (list scanning) + RELATIVE (detail reading); Last update column add (TicketListTable grid 7→8 cols); default sort flip `updated_at_desc` + sort-aware cursor keyset extension `DecodedCursor: { v, id, s }` với legacy `{opened_at, id}` graceful fallback; type filter scoped active platform với disabled state + tooltip hint when no platform + atomic `type_id` clear on platform change (Pattern 9 defense-in-depth); `buildSavePayload(draft)` helper extraction Pattern 9 defensive crystallized — pure mapper TS-typed, layer 12 omissions become compile errors. Path A tests +16. |
| `27ec2ce` | **PR-17.2** | Ticket detail polish (2 sub-chunks): reverse entry order `getTicketWithEntries .order('created_at', { ascending: false })` Manager triage focus, index `(ticket_id, created_at DESC)` answers query directly zero perf cost; version list display `extractVersions` util pure helper sister-file pattern + inline `VersionsSection` trong `TicketDetailPanel` mockup-style chevron-separated chips với rose-accent latest + "← latest" suffix + silent omission khi empty. Path A tests +6. |
| `b9f8876` | **PR-17.2.5** hotfix | extractVersions nested data shape — Manager UAT MV6 image evidence: VersionsSection omitted on a ticket type=app với version 4.4.0 (Apple, type_payloads has 1 entry). Root cause: helper read `p.version` (top-level) but production exclusively wrapped `p.payload.version` per RPC INSERT shape since PR-9 (`jsonb_build_object('payload', v_type_payload, 'first_seen_at', ...)` trong migration `20260423000000`). Fix: read `p.payload.version` (strict nested only). Test fixtures rewritten production-realistic + 3 defensive tests cho nested edge cases. Path A tests +3. |

**Test count:** 1121 (post-PR-16) → **1141** (post-PR-17) = **+20 tests** cumulative.

**Manager UAT verification (MV1-MV6 all ✅):**
- MV1 Date format `dd/MM/yyyy HH:mm` trong inbox list
- MV2 Last update column functional + sort-aware
- MV3 Default sort `updated_at_desc` + cursor pagination intact
- MV4 Type filter scoped active platform với disabled state + tooltip + atomic clear
- MV5 Reverse entry order trong ticket detail (newest top — Manager triage)
- MV6 Version list display (1-version visible + multi-version chevron chips) — verified post-PR-17.2.5

**Memory pattern reuse:**
- Pattern 9 N-layer cascade audit reuse #2 (PR-17.2.5) — test-infrastructure drift class; 13-point checklist evolution adds Layer 0 ("trace data flow source-to-consumer; verify test fixture matches production storage shape")
- Pattern 10 Domain assumption pivots reuse #6 (PR-17.2.5) — Manager UAT image evidence + production data shape investigation; cumulative 6 instances proven

Reference: [`docs/store-submissions/CURRENT-STATE.md`](docs/store-submissions/CURRENT-STATE.md) PR-17 milestone section cho comprehensive scope, 6 decisions locked, memory pattern reuse confirmations, UAT matrix, PR-18+ candidates.

### Open follow-ups (PR-18+)

(None specific to PR-17 — `buildSavePayload(draft)` helper extraction shipped PR-17.1.e; PR-18+ candidates list consolidated trong CURRENT-STATE.md PR-17 milestone section.)

## PR-16 — Auto-mark-done + auto-completed banner + auto-reopen Manager opt-in ✅ COMPLETED (2026-05-02 / 2026-05-03)

4 sub-PRs + 1 hotfix shipped across 2 days. 8 commits, 8 migrations applied production sequential.

| Commit | Sub-PR | Scope |
|---|---|---|
| `6ffe7b0` | **PR-16a.1+16a.3** | Auto-DONE foundation bundle — `subject_patterns.auto_done_eligible` column + `build_rules_snapshot` / `save_rules_tx` / `rollback_rules_tx` threaded + TS schema cascade (queries, schemas, helpers, actions) + Settings UI emerald toggle với UX guard disabled cho non-APPROVED outcome + 7 fixture sites updated. |
| `c231594` | **PR-16a.2** | `find_or_create_ticket_tx` auto-DONE branch — CLASSIFIED + APPROVED + eligible pattern → ticket born trong DONE state với `closed_at` + `resolution_type` set atomically. STATE_CHANGE entry với `metadata.{actor:'system', reason:'auto_mark_done_initial', subject_pattern_id}`. Reclassify Q6.B inheritance free. Idempotency caveat documented header. `ClassifiedResult.subject_pattern_id` propagation. |
| `cc8389d` | **PR-16a.4** | Path A unit tests (+8) — classifier subject_pattern_id propagation, engine auto-DONE response shape, schemas accept + back-compat (input + snapshot), helpers round-trip. Migration header idempotency caveat documentation. SQL behavior validated via Manual QA Scenario 3+. |
| `2d5f171` | **PR-16a.5 hotfix** | handleSave payload threading — Manager UAT Scenario 2 surfaced 7-layer cascade gap (Layer 9 `EmailRulesClient.handleSave` intermediate payload). Zod `.default(false)` silently coerced missing field. 1-line fix + N-layer cascade audit memory crystallized post-fix. |
| `6b820e9` | **PR-16b.1+16b.2** | Auto-completed banner + dedicated view — `count_auto_completed_tickets()` + `list_auto_completed_tickets()` RPCs với latest-STATE_CHANGE EXISTS subquery + `getAutoCompletedCount()` + `listAutoCompleted()` query module + Inbox blue/info banner Q1.E + dedicated `/auto-completed` view với MANAGER soft redirect + friendly empty state. |
| `32c8cbe` | **PR-16b.3+16b.4** | Auto-reopen RPC + Path A tests (+7) — pre-LOOP branch trong find_or_create_ticket_tx Q2.D + Q3.B (DONE → IN_REVIEW on REJECTED). Detection: latest STATE_CHANGE actor='system' + reason LIKE 'auto_mark_done%'. PR-15.5 stale filter preserved. SUPERSEDED by PR-16b.5.5 eligibility gate. |
| `b455fa9` | **PR-16b.5 Bundle A** | Auto-reopen Manager opt-in foundation — `subject_patterns.auto_reopen_eligible` BOOLEAN DEFAULT FALSE column + rules RPCs threaded với both fields + Settings UI 7th column toggle với amber accent + ⚠️ warning tooltip + UX guard disabled cho non-REJECTED + 13-point cascade audit applied successfully (Layer 9 explicit, no hotfix needed — first reuse of PR-16a.5 memory pattern). |
| `3aa093b` | **PR-16b.5 Bundle B** | RPC eligibility check + Path A tests (+5) — `find_or_create_ticket_tx` auto-reopen branch gated by `pattern.auto_reopen_eligible`. Two-phase short-circuit: cheap gate trước expensive EXISTS subquery. Default FALSE preserves "build mới = ticket mới" Apple workflow semantic. Schema validation tests + draft round-trip với shallow-merge defensive. |

**Test count:** 1101 (post-PR-15.5) → **1121** (post-PR-16) = **+20 tests** cumulative.

**Manager domain insight (PR-16b.5)**: Apple's REJECTED workflow is per-build (different `submission_id`), không cùng build APPROVED trước. PR-16b.3 auto-reopen-always violated this. Path D opt-in flag preserves correct semantic. Code preserved cho future Apple workflow flexibility.

**Manager UAT verification:**
- Phase 1 (Settings UI + persistence): ✅ verified Scenarios 1-2 + X-Y-Z
- Phase 2 (Banner + visibility): ⏸ data-dependent
- Phase 3 (Real Apple email): ⏸ chờ live emails (Scenarios 3-7, C, W)
- Phase 4 (Long-term telemetry): ⏸ 1-2 months data informs PR-18+ decisions

Reference: [`docs/store-submissions/CURRENT-STATE.md`](docs/store-submissions/CURRENT-STATE.md) PR-16 milestone section cho comprehensive scope, design decisions Q1-Q8 với 5 overrides, schema changes summary, UAT matrix, PR-18+ candidates.

### Open follow-ups (PR-18+)

- [ ] [PR-18+] **Q1.E + Q8 telemetry capture** — banner click frequency, time-series, state=APPROVED count cho Q8 Approved tab fate decision criteria. Manager UAT Phase 3-4 informs priority.
- [ ] [PR-18+] **Path C DB integration test infrastructure** (~3-4h scope) — covers SQL behavior gaps trong Path A coverage: auto-DONE branch logic, eligibility gate, idempotency edge case (defensive double-call test deferred from PR-16a.4 caveat). Reinforced by PR-17.2.5 hotfix (test-infrastructure trap exposed; Path A unit fixtures drifted from production storage shape).
- [x] ~~**`buildSavePayload(draft)` helper extraction**~~ — ✅ shipped PR-17.1.e (Pattern 9 defensive crystallized as canonical mapper).
- [ ] [PR-18+] **Q2.B reopen affordance** — Manual QA Scenario D pending; if absent từ TicketDetailPanel, add per-ticket reopen button cho DONE tickets (parity với mark_done_ticket_tx). May already exist trong existing UI.

## Post-PR-11 — TicketDetailContext + prop drilling cleanup (planned)

`currentUserId` and `userRole` are now threaded 4 layers (page → InboxClient → TicketDetailPanel → TicketEntriesTimeline → EmailEntryCard / CommentEntryCard). Acceptable for current scope but if PR-12+ adds 2+ more consumers (e.g. assignee chip, priority widget), promote to a React context provider on the panel root. Not urgent — both props are stable for the panel's lifetime.

## PR-10 — Inbox UI ✅ COMPLETE 2026-04-25 (shipped via PR-10a / PR-10b / PR-10c / PR-10d)

Original scope preview (detailed in `docs/store-submissions/CURRENT-STATE.md` PR-10 section):

- Ticket list page với filters (state, app, platform, assigned_to, priority, date range)
- State buckets: `NEW` / `IN_REVIEW` / `REJECTED` / terminal (`APPROVED` + `DONE` + `ARCHIVED`)
- Unclassified buckets as dedicated views + manager reclassify flow (spec §5.2 merge)
- Ticket detail modal với `ticket_entries` timeline (EMAIL snapshots + STATE_CHANGE + COMMENT + PAYLOAD_ADDED)
- User action primitives: archive / follow-up / mark-done / assign / priority / comment / reject-reason — each a separate `*_tx` RPC per spec §2.2
- First consumer of PR-9 extended `FindOrCreateTicketOutput` fields

Dependencies: PR-9 RPC is the sole write path for email-driven transitions. User-action RPCs are a separate, additive surface (spec §7) — PR-9 did not ship them.

## PR-10a Post-MVP (surfaced during Inbox UI implementation)

- [ ] [PR-10a] Sortable column headers in `TicketListTable` — `components/store-submissions/inbox/TicketListTable.tsx` — currently sort is FilterPill-only to avoid two UI surfaces for the same state. Revisit if usability feedback shows users expect header sort (click column → toggle direction).
- [ ] [PR-10a] Priority column in `TicketListTable` when `sort=priority_desc` is active — today only HIGH renders inline with display_id as a red badge; LOW/NORMAL are hidden to reduce visual noise. A dedicated column would help when the user explicitly sorts by priority.
- [ ] [PR-10a] Consolidate `PlatformIcon` — duplicated between `components/store-submissions/apps/AppsClient.tsx:54-74` and `components/store-submissions/inbox/TicketBadges.tsx`. Promote to `components/store-submissions/shared/PlatformIcon.tsx` on the 3rd usage per the codebase's "abstract on 3" rule.
- [ ] [PR-10a] Absolute-date fallback for very old ticket `opened_at` — `formatDistanceToNow` produces "about 2 months ago" style; for dates >30d an absolute format ("Apr 22") is more precise. Acceptable for MVP since triage tickets rarely linger that long.
- [ ] [PR-10a] Bulk actions (multi-select archive / mark-done) — deferred per scope trim. 200 tickets/month volume doesn't demand it yet. Revisit when user patterns show repetitive per-ticket actions.
- [ ] [PR-10a] Count badges on state tabs (NEW: 12, REJECTED: 3, ...) — deferred per scope trim. Requires `listTicketCounts()` aggregate query. Add when users request at-a-glance queue visibility.
- [ ] [PR-10a] Search by app name + email subject — MVP search is `display_id` ILIKE only. App-name search needs a two-pass subquery; subject search requires joining `email_messages`. Revisit when dataset grows or users complain.
- [ ] [PR-10a] `updated_at_desc` / `priority_desc` sort pagination — cursor keyset is keyed by `(opened_at, id)` and only honored for `opened_at_desc`; other sorts return `next_cursor: null`. Low priority since the useful pagination pattern is newest-first. If deep history browsing by updated/priority becomes needed, extend the cursor shape.

## Apple IAP per-territory availability arc (SC1-SC7) ✅ SHIPPED 2026-08-17 (19051e8..6f206f8)

Deferred deliberately at arc close. Each needs its own commit; none is a blocker.

- [ ] [SC4-debt] Open-reset clears the search box on any `initialEntries` identity change, not only on open — `components/iap-management/iap-form/CustomPricesDialog.tsx:127-133` + `components/iap-management/territory/TerritoryPickerShell.tsx:118-124` — the reset effect depends on `[open, initialEntries]`, so an inline `initialEntries={[]}` from a parent gives a fresh array every render and wipes the box mid-typing. SC4 reproduced the pre-existing semantics EXACTLY via `filterEpoch` rather than fixing it inside a refactor, because a silent behaviour change there would have masked whether the extraction itself regressed. Fix in a standalone commit: memoise at the call site, or narrow the effect to `open`. Do NOT fold into an unrelated change.
- [ ] [SC5/SC7-accepted] `getAllTerritoryIds` memoises at module scope, 1h TTL, per process — `lib/iap-management/apple/availabilities.ts:80-81` — so replicas can hold different catalogues for up to an hour. Known consequences, both acceptable: a territory Apple just ADDED is invisible for ≤1h; one Apple just REMOVED produces a VISIBLE 400 on push. ⚠ THIS IS P6-CLASS AND DELIBERATE — DO NOT "FIX" IT IN ISOLATION. The same cache already feeds the write path (`setAvailabilityToAllTerritories`, and `bulk-import/execute` resolves it once per batch), so display and write read ONE source. Making the display side fresher while the write side stays cached is the actual bug: it would let the picker show "176 of 176" while Apple receives 175. Any change here must move BOTH sides together, or replace the cache wholesale.
- [ ] [SC7-declared-limit] No HTTP-level e2e reaches the execute route's per-row loop — `app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts` — the route takes multipart FormData and would need the entire Apple create pipeline mocked to get past parse/resolve, and `execute/route.test.ts` deliberately covers only the early exits (401/400/422/502). The chain is instead held from both ends around one shared function: the wizard asserts what it posts (`BulkImportWizard.territories.test.tsx`), the resolver is asserted directly (`bulk-availability-view.test.ts`), and the route calls that same resolver (`lib/iap-management/apple/bulk-availability-view.ts:~250`). ⚠ Recorded as a DECLARED limitation, not a forgotten gap — if a local supabase/Apple-stub harness ever lands, this is the first thing to close with it.

## Set Availabilities A′ arc (SA1-SA3) ✅ SHIPPED 2026-08-18 (20aa35e..4b16666)

Found while building A′; each deliberately NOT folded into it.

- [ ] [SA2-scoped-out] The two all-or-nothing modes still pre-read the FULL list on open — `components/iap-management/AvailabilitiesBulkModal.tsx:~330` — so `set-all` and `remove` keep the exact rate-limit exposure A′ removed from `set-territories`: ~1,000 Apple reads at N=500, ~2,000 at N=1000, before the Manager clicks anything. ⚠ THIS IS A MANAGER-SCOPED DECISION, NOT AN OVERSIGHT — the brief locked "hai mode cũ giữ nguyên filter", and their list filter IS by current availability (decision 5) with no other source (no local column, no batch read, no cache — KB §4.15, design §2f). Closing it means moving decision 5's filter to confirm-time for those modes too, exactly as design PART 3 proposed and the Manager declined for now. The machinery is already built and reachable (`runAvailabilityReadPhase`, `buildConfirmBuckets`), so the change is wiring plus copy, not new logic. Revisit if a Manager hits the wall on a large app via those two buttons.
- [ ] [SA2-upstream] `seedMissingIapStubs` failure is silent — `app/(dashboard)/iap-management/apps/[appId]/page.tsx:106` inside the `catch {}` at `:122` — a failed seed empties `appleToInternal`, which now surfaces honestly in the modal as "Not linked locally — run Refresh from Apple" (SA2) but still gives the Manager no signal on the PAGE, where the failure actually happened. The modal fix treats the symptom; the page swallowing the cause is the disease. Fix: surface a page-level warning banner when seeding threw, distinct from the "no IAPs" empty state. ⚠ Do not widen the `catch {}` scope while doing it — the other lookups in that block (drafts, templates) are genuinely non-essential to the read view and should keep degrading silently.
- [ ] [SA-followup] Windowed rendering is a slice + "Show more", not virtualisation — `components/iap-management/AvailabilitiesBulkModal.tsx` (`ROW_WINDOW_STEP`) — a Manager who clicks Show-more repeatedly on a 1,000-item app still ends up with 1,000 mounted rows. Acceptable because search is the primary path and the counts stay honest at any window size, but if row-mount cost is ever measured as a real problem, swap the slice for a virtual list. ⚠ Whatever replaces it must keep "Select all = all matching, never the rendered set" (`toggleAllForQuery`) — that invariant is the one a virtualiser makes easy to break.

## Availability mirror arc (C1-C6) ✅ SHIPPED 2026-08-26 (`ddf8dd6`)

Census kickoff verified the Manager's own description of the tool against the
code before anything was designed. Two of the three claims were wrong, and the
one that was right is the reason the arc was cheap.

- **M1 ✅ the Manager was right, and the U3 trap was NOT present.** The list
  column showed real availability — `getAvailabilityForIap` (2-step read, Step
  B counts territories), classified by `classifyAvailability`. It never read
  `include=inAppPurchaseAvailability` presence as a verdict, which is the
  defect the census was sent to look for.
- **M2 ❌ nothing was cached, anywhere.** No DB column, no lifted state,
  `cache: "no-store"` on the fetch, no cache on the route. Each cell held its
  own `useState` and lost it on unmount. So there was no timestamp that could
  survive a page visit, and therefore no honest "as of last sync" to render —
  which is what made the mirror a prerequisite rather than an optimisation.
- **M3 ❌ "Refresh from Apple" never asked Apple about availability.**
  `sync-states` read the IAP list and wrote `state`; the column stayed frozen.
  Worse on the write side: `bulk-availability` wrote `actions_log` and nothing
  else, so after a Remove from Sales the column kept saying "Available" until a
  hard reload.
- **M4 📊 the cost that was already being paid**: 2 requests per item, 100 rows
  per page ⇒ ~200 Apple requests per scroll, every visit. On the key pool with
  retry, but with no latch shared across cells — registered as
  `[AVAIL-cell-no-latch]` and deliberately not fixed here.

⚠ **C3 was four emitters, not one.** The kickoff said "write-through in
`bulk-availability`". Grepping `setAvailabilityTerritories` found FOUR call
sites (bulk, Edit via `update-orchestration`, Bulk Import, Create on Apple);
patching one would have left Edit and Bulk Import as the surfaces the mirror
was blind to. Bulk Import cannot use the UPDATE helper — at the moment it knows
the outcome it is building an UPSERT on `(app_id, product_id)` for a row that
may not exist — hence **two delivery shapes, ONE column definition**
(`availabilityMirrorColumns`). P1, applied before the twins existed.

⚠ **A P5 near-miss worth remembering.** In `create-on-apple` the mirror write
was first placed INSIDE the availability `try`. `getAllTerritoryIds`'s 1-hour
cache can expire, and a refill is a real Apple call that can 429 — which would
have landed in that `catch` and reported "availability set-all failed" for a
write Apple had already accepted. Moved outside, guarded by `availabilitySet`.
The status principle is not only about button-vs-outcome; it is also about
which statement happens to throw last inside a block.

- [x] ~~**U-availability write-side** (the observation left hanging by U3)~~ ✅
  **CAUSE FIXED, not merely observed.** The original question was "Remove from
  Sales in the tool → Refresh from Apple → does Status flip to
  `DEVELOPER_REMOVED_FROM_SALE`?", and the census showed the observation as
  written could not be trusted: the Availabilities column would NOT move on a
  Refresh click (the cell never unmounts, and its observer effect returns early
  on any non-pending state), so a Manager running it would have had to press F5
  to see the truth and could have concluded the removal failed. C3 (write the
  mirror on an accepted write) + C5 (adopt a newer mirror mid-life) remove the
  cause. **How to run it now:** Remove from Sales → the Availabilities column
  must change **without F5**. If F5 is still needed, that is a bug in C5's
  mirror-adoption effect, not a fact about Apple. The separate `state`-flip
  question is answered by verify query **V6**
  (`docs/iap-management/queries/verify-availability-mirror.sql`), which joins
  `actions_log` AVAILABILITY_* rows against the mirror's freshness — no UI
  observation needed. ⚠ Still untested and still worth naming:
  `REMOVED_FROM_SALE` (the Apple-initiated variant) has 0 rows anywhere.

## Export list — item selection design (design only, 2026-08-24, `c7e24ff`)

Design: `docs/iap-management/design-export-list-item-selection.md`. Found while gating it; none folded in.

- [x] ~~**[EXPORT-availability-filter]**~~ ✅ **SHIPPED 2026-08-26** (`ddf8dd6`, chunks C1-C6) — and it was built, not closed as won't-build. ⚠ **The census that preceded it reversed the premise.** The design assumed the paid filter would cost ~1-2 Apple requests per selected item; verifying the Manager's description of the tool line by line showed the list column was ALREADY paying 2 requests per item on every single mount and throwing the answer away (no DB column, no lifted state, `cache: "no-store"`, no route cache — census M2). So the feature is not new spend: `iap_mgmt.iaps.availability_{state,territory_count,synced_at}` (migration `20260828000000`) keeps what was already being bought, and the wizard's Available/Removed/**Unknown** facet reads it for **0 Apple requests** — the U4 lock intact, pinned by `IapListClient.availability-filter.test.tsx`. ⚠ **Unknown is a first-class third bucket and must stay one**: an item never synced is neither available nor removed, and folding it into Available is the U3 defect wearing a different hat. ⚠ The raw Apple-status control **stays** beside it, per row and per filter — U3's 35/35 agreement is measured, not guaranteed, so a divergence has to be visible rather than pre-resolved by the tool.
- [x] ~~**[EXPORT-avail-read-halving]**~~ ✅ **APPLIED 2026-08-26** (`ddf8dd6`, C4) — closed **in full for the sweep path, which is the only path that reads at scale**. `listAllInAppPurchases(creds, appId, { includeAvailability: true })` (opt-in; every other caller keeps the smaller payload) yields `data[].relationships.inAppPurchaseAvailability.data.id` **and** `included[].attributes.availableInNewTerritories`, so `runAvailabilitySweep` skips Step A entirely: **1 request per item, not 2** (`getAvailabilityByIdForIap`). A 500-item Refresh costs ~503 instead of ~1,003. ⚠ **What is NOT converted, deliberately**: the per-item lazy route (`GET /iaps/{id}/availability`) still pays 2, because it is handed one internal id and has no list in hand to take the availabilityId from — and after C5 it fires only for items the mirror has never seen, so the remaining 2N is now an N-that-shrinks-to-zero rather than a per-mount cost. A′'s `runAvailabilityReadPhase` is likewise untouched: it reads a Manager-chosen SELECTION at confirm time, not a catalogue. ⚠ **The include supplies an ID AND NOTHING ELSE** — `availabilityIdFromListedIap` carries the warning: Apple populates the relationship for every IAP (0/29 missing) and the included resource has `links` only for `availableTerritories`, so presence cannot classify. Reading it as "available" IS U3.
- [x] ~~**[GUIDE-label-drift]**~~ ✅ **method recorded 2026-08-27** (`026478d`, KB §16.7 P27-applied-to-docs) — a guide that quotes a UI label is making an unchecked CLAIM about the code, and a WRONG label reads perfectly. The 2026-08-27 pass found five, including one in no arc being documented: a Bulk Availabilities confirm button drawn as `Set Avail. for 5`, a label that has never existed (`OK (N selected)`), surviving several arcs and a Manager UAT because it is exactly what the button ought to say. ⚠ **The method is mechanical, and reading is not it**: grep every claimed label back to its component, and grep retired copy to 0 hits — case-sensitively, since `Pricing Tiers` came back clean while `Pricing tiers` was still live elsewhere. Do this on every guide pass, not only when something looks wrong.
- [x] ~~[EXPORT-catalog-missing-11] — **CLOSED FOR APPLE 2026-08-27 (arc G).**~~ The Apple export picker now builds its list from `apple/apple-territory-catalog.ts` = Apple's own 175 (`[Q-EXPORT.apple-only-picker]`), so **all 11 markets below — Russia included — are tickable and exportable.** ⚠ **`TERRITORY_CATALOG` WAS NEVER TOUCHED**, which is why this closed without the P8 gate: the codes come from Apple's snapshot, so Google's picker is byte-identical and no unchecked market was offered to Play. The 19 catalog entries Apple does not sell to are simultaneously gone from the Apple picker and from the file (G3 + G4).
  ⚠ **STILL OPEN FOR GOOGLE, and that is a separate question.** Google keeps all 183 from the shared catalog, and whether Play sells in these 11 has **never been measured** — see `[GOOGLE-regions-unmeasured]`. Do not read this checkbox as "the catalog is complete".
  ⓘ Original entry preserved below for the record.

- [x] ~~[GOOGLE-regions-unmeasured]~~ ✅ **MEASURED AND CLOSED 2026-09-01 — the number is 173.** Three independent sources agree 100%, 0 codes differing in any pair: M1 (`convertRegionPrices`, `regionsVersion` "2025/03") = 173 · census Q7 over 308,933 price rows = 173 · Play Console's **Pricing** screen (Manager-supplied) = 173. The arithmetic closes against the old shared catalog: `183 − 25 + 15 = 173`. ⚠ **15 markets Google sells in were never tickable** (`AW BM BY CF ER GI KY LY RU SO TC VA VG YE ZW` — Russia among them, the same commercial gap Apple had) and **25 tickable entries are markets Google does not sell in**. ⚠ **`regionsVersion` is a drift detector Apple does not have** — Google states its own catalog version, so X4 must key off it rather than porting Apple's code-by-code comparison. Full detail + the two lists: `docs/google-iap-management/BACKLOG.md`. ⓘ Original entry below.
  ⓘ ~~[GOOGLE-regions-unmeasured] **Nobody has measured which regions Google Play actually sells in** — the Google export picker offers the shared `TERRITORY_CATALOG` (183) and `lib/google-iap-management/` contains no region list to check it against (`grep GOOGLE_REGIONS|PLAY_REGIONS` → nothing). So two questions are unanswered: are there codes Google does NOT support that users can still tick, and codes Google supports that the catalog lacks? ⚠ Apple's half of this is now settled and Google's is not — the asymmetry is the point of this entry.
  ⓘ Cheapest measurement, ~1 request: `monetization.convertRegionPrices` is Google's own canonical "every supported region" call and the wrapper already exists — `buildRegionMapFromBasePrice()` (`lib/google-iap-management/google/regions-helper.ts:76`). It also returns `regionVersion`, the field that caused Hotfix 9. A read-only probe mirroring `scripts/probe-export-price-sources.mjs` would settle it.
  ⚠ Blocks: the P8 gate on any catalog widening, and any Google equivalent of `[Q-EXPORT.apple-only-picker]`.~~ **← both unblocked as of 2026-09-01.**

- [ ] [APPLE-export-wizard-docblock-183] **`ExportItemWizard.tsx:12` still says the country step offers `TERRITORY_CATALOG`, 183 entries — it has offered Apple's 175 since arc G3.** The docblock reads *"Step 2's territory list is `TERRITORY_CATALOG`, 183 entries computed at module load"*, while line 306 of the same file passes `catalog={APPLE_TERRITORY_CATALOG}` (175) with its own ⚠ comment explaining why. ⚠ **This is the APPLE module** — filed here rather than in the Google backlog because the file, the catalog and the arc that changed it are all Apple's; the Google census only noticed it in passing. ⚠ Same class as `[GUIDE-label-drift]`, one layer in: a docblock making an unchecked claim about the code beneath it, and reading perfectly while doing so. Cost is one paragraph; the reason it is worth filing is that this docblock is the first thing anyone reads before touching the shared `ExportOptionsDialog` (P8).

- [ ] [GOOGLE-export-intersection-silent-drop] **Google's export still uses the INTERSECTION that E2 removed from Apple** — `lib/google-iap-management/xlsx-export.ts:126-128`: `territories = selection ? allTerritories.filter(t => selection.has(t)) : allTerritories`. A region the operator ticks that no exported product has a price for **produces no column at all** — no `—`, no note, nothing saying the question was dropped. Apple had exactly this bug and fixed it in E2 ("the selection IS the column set"); the Google twin was never ported. ⚠ **Becomes worse the moment `[GOOGLE-regions-unmeasured]` finds unsupported codes**, since those are precisely the ticks that would vanish. Fix is E2's, one file over.

- [ ] ~~[EXPORT-catalog-missing-11] (original text)~~ **11 Apple markets cannot be exported at all, because they cannot be SELECTED** — `lib/iap-management/territory-catalog.ts`. The Export-options dialog builds its list from `TERRITORY_CATALOG` (183 alpha-2 entries); Apple sells to 175 territories (`/v1/territories`, measured 2026-08-27). Eleven of Apple's are absent from the catalog, so no Manager can tick them and no export can ever contain their prices:

  | | | |
  |---|---|---|
  | `RU` | **Russia** | the one that matters commercially |
  | `BY` | Belarus | |
  | `YE` | Yemen | |
  | `ZW` | Zimbabwe | |
  | `LY` | Libya | |
  | `KY` | Cayman Islands | |
  | `AI` | Anguilla | |
  | `BM` | Bermuda | |
  | `MS` | Montserrat | |
  | `TC` | Turks & Caicos | |
  | `VG` | British Virgin Islands | |

  ⚠ **Say it plainly: the tool currently cannot export prices for 11 markets Apple is actively selling in, Russia included.** E2 did NOT fix this — E2 fixed the different bug where a *selected* territory silently lost its column. A territory that cannot be selected never reaches that code.

  ⚠ **PARTIALLY RELIEVED BY F-B (2026-08-27), and only on one path.** "All countries" now expands to catalog(183) ∪ Apple(175) = **194 columns** at the Apple route (`apple/export-territory-expansion.ts`), so ticking *all* DOES produce a Russia column with Russia's real price — without touching the shared catalog, hence without the P8 exposure. **Ticking Russia individually is still impossible**, because the dialog builds its list from `TERRITORY_CATALOG`. That asymmetry is the remaining defect and it is exactly what closing this item removes. Do NOT close this on the strength of the "all" path working.

  ⚠ **CONDITION BEFORE DOING IT (P8): check Google first.** `TERRITORY_CATALOG` is shared with the Google IAP module's export dialog, so adding 11 entries adds 11 rows to Google's picker too. Confirm Google Play actually sells in those regions before widening a list both modules read — otherwise this trades a silent gap on one surface for a misleading offer on the other.

  ⚠ Kosovo is NOT in this list. It IS in the catalog (`XK`) and was unreachable for a different reason — Apple codes it `XKS` and ISO codes it nothing — fixed at the Apple boundary in E2b (`apple/territory-code-map.ts`), deliberately without touching the shared catalog, because Google needs `XK` (`region-continent.ts:37`).

  ⓘ **The other direction is fine and needs no work.** **19** catalog entries are territories Apple does NOT sell to (AD BD BI DJ ET GN GQ HT KI KM LI LS MC MH SM TG TL TV WS). ⚠ **Corrected 2026-08-27 from "20 … XK …":** Kosovo was in that list by mistake. Apple DOES sell to Kosovo — it appears as `XKS` in `/v1/territories` — and the old count compared alpha-2 catalog codes against alpha-3 Apple codes, i.e. it was measured before `territory-code-map` existed to normalise the two. The arithmetic is what caught it: `183 − 20 + 11 = 174`, one short of Apple's measured 175, while `183 − 19 + 11 = 175` closes exactly. Both numbers are now pinned by `lib/iap-management/apple/export-territory-expansion.test.ts`, so the next drift is a red test rather than a paragraph nobody re-derives. They are selectable and answer `—` meaning "Apple does not sell here" — that is the honest response to the question, not a defect. ⚠ **Attribution corrected:** this line previously credited E2, which is only half of it. E2 gave those countries a *column* (before it, the intersection deleted them); the column's cells were still **blank**, indistinguishable from a failed read. **E5** is what puts `—` in them and makes a blank mean exactly one thing. Both are required for the sentence above to be true.

  ⓘ **Verified still accurate 2026-08-27 (E5 close):** the 11 codes, the Russia call-out, the P8 condition and the Kosovo exclusion are all as measured. Nothing to tick — the P8 check against Google Play has not been run, and it is the gate.
- [ ] [GOOGLE-export-no-test] **Google's export path has no test at all, so "Google is unaffected" is a weaker claim than it sounds** — `components/google-iap-management/iap-list/IapListClient.tsx:607` renders the shared `ExportOptionsDialog`, and `IapListClient.test.tsx` mentions "Export" **zero** times. G3 added an optional `catalog` prop whose default preserves today's behaviour, and that default IS pinned — but only from the Apple side, by `ExportOptionsDialog.apple-catalog.test.tsx` ("the DEFAULT is still the shared 183") and by the 13 untouched contract tests. **Nothing exercises Google's own render.** So a future change to Google's caller — passing a catalog, passing the wrong one, dropping the dialog — would go unnoticed by this repo's suite.
  ⚠ **Weakest link is the wiring, not the component** — exactly the P26 shape G3 hit on the Apple side: the dialog was proven correct *when given* Apple's catalog while nothing proved the wizard *gave* it one, and the mutation stayed green until a wiring test was added. Google has that same gap and no wiring test.
  ⓘ Cheapest fix: one jsdom test that renders Google's `IapListClient`, opens the export dialog, and asserts `183 of 183 selected` + a market Apple does not sell to (e.g. Andorra) is present. Mirrors the Apple wiring test added in G3.

- [ ] [CATALOG-currency-wrong] **`TERRITORY_CATALOG` states the wrong currency for 96 of 164 Apple markets (58.5%) — and the Apple Custom Prices dialog shows it** — `lib/iap-management/territory-catalog.ts`. Measured 2026-08-27 against `/v1/territories` (probe step 2.6b). Apple does not bill in the local currency for most markets: it collapses **93 to USD and 3 to EUR** (KB §4.19). The catalog column was hand-written per country, so it is right about the country and wrong about Apple.

  **Where it reaches a user.** `custom-prices/baseline.ts:186-190` builds `currency_code` from a 4-level fallback:
  `custom ?? template ?? manual?.currency ?? territory.currency ?? null`. The third rung is Apple's real answer — but it only exists when the territory has a MANUAL price, which is **10 of 175** on a typical item. The other **165 fall through to `territory.currency`**, the catalog guess, and it renders at `CustomPricesDialog.tsx:638` in the column beside the price the Manager is about to type.

  ⚠ **Severity, measured not assumed.** The displayed currency IS submitted with the custom price (`CustomPricesDialog.tsx:257`), so a Manager reading "BGN" types a BGN figure into a market Apple bills in EUR. But the Apple WRITE does not use it: `pricing-orchestration.ts:738` carries `currency_code` into the **audit log only**, and price-point matching is on `customer_price` (KB §4.2). ⇒ a misleading label on a write-adjacent input, **not** a silent currency conversion in the write.

  ⚠ **DO NOT fix by editing `TERRITORY_CATALOG` (P8).** It is shared with Google's export picker, and Google Play's billing currencies are a different question that is **still unmeasured** (see `[GOOGLE-regions-unmeasured]`). Editing it would make Apple right and Google unknown. The Apple-side fix is to read `appleCurrencyFor()` from `apple-territories.snapshot.ts` on Apple paths and leave the catalog to Google.

  ⓘ **Partially relieved by G3 (PA-1)**: once the Apple export picker is built from the snapshot, the *picker's* currency column becomes Apple's answer. The Custom Prices dialog is a different surface and is NOT covered by that.

  The 96, `catalog→Apple`:

  AF AFN→USD · AG XCD→USD · AL ALL→USD · AM AMD→USD · AO AOA→USD · AR ARS→USD · AZ AZN→USD · BA BAM→EUR · BB BBD→USD · BF XOF→USD · BG BGN→EUR · BH BHD→USD · BJ XOF→USD · BN BND→USD · BO BOB→USD · BS BSD→USD · BT BTN→USD · BW BWP→USD · BZ BZD→USD · CD CDF→USD · CG XAF→USD · CI XOF→USD · CM XAF→USD · CR CRC→USD · CV CVE→USD · DM XCD→USD · DO DOP→USD · DZ DZD→USD · FJ FJD→USD · GA XAF→USD · GD XCD→USD · GE GEL→USD · GH GHS→USD · GM GMD→USD · GT GTQ→USD · GW XOF→USD · GY GYD→USD · HN HNL→USD · IQ IQD→USD · IS ISK→USD · JM JMD→USD · JO JOD→USD · KE KES→USD · KG KGS→USD · KH KHR→USD · KN XCD→USD · KW KWD→USD · LA LAK→USD · LB LBP→USD · LC XCD→USD · LK LKR→USD · LR LRD→USD · MA MAD→USD · MD MDL→USD · MG MGA→USD · MK MKD→USD · ML XOF→USD · MM MMK→USD · MN MNT→USD · MO MOP→USD · MR MRU→USD · MU MUR→USD · MV MVR→USD · MW MWK→USD · MZ MZN→USD · NA NAD→USD · NE XOF→USD · NI NIO→USD · NP NPR→USD · NR AUD→USD · OM OMR→USD · PG PGK→USD · PY PYG→USD · RS RSD→EUR · RW RWF→USD · SB SBD→USD · SC SCR→USD · SL SLE→USD · SN XOF→USD · SR SRD→USD · ST STN→USD · SZ SZL→USD · TD XAF→USD · TJ TJS→USD · TM TMT→USD · TN TND→USD · TO TOP→USD · TT TTD→USD · UA UAH→USD · UG UGX→USD · UY UYU→USD · UZ UZS→USD · VC XCD→USD · VE VES→USD · VU VUV→USD · ZM ZMW→USD

- [ ] [AVAIL-cell-no-latch] **The list's per-item availability reads share Apple's budget but not a stop latch** — `components/iap-management/AvailabilityCell.tsx` → `GET /api/iap-management/iaps/{id}/availability`. Each cell is its own route invocation with its own `withRetry` (4 attempts); `stoppable-pool`'s latch lives in the ORCHESTRATORS (`bulk-availability`, `export-fetch`, `pricing-orchestration`) and nothing joins the cells together, so a 429 on cell A does not stop cells B..Z. Worst case in one storm: 100 cells × 4 attempts. ⚠ **NOT a `[PRICING-429]` twin** — that one was "a 429 got swallowed so the latch never saw it"; this path *has* retry, *has* the key pool + its cooling (`iapFetch` → `appleFetch(..., { keyPool })`), and each cell does stop itself (renders `rate limited`, no auto-retry). What is missing is a shared latch across cells. ⚠ **C5 mirror-first (`ddf8dd6`) made this much smaller**: a cell with a mirror record never fetches, so scrolling a 100-row page went from ~200 Apple requests every visit to ~0 from the second visit onward. The storm is now only reachable on **the first read of an app, or on items still NULL** — which is also exactly the set "Refresh from Apple" (C4, latched, stop-and-preserve) is there to fill. Left open rather than fixed because the population that can still trigger it shrinks every time anyone uses the tool. If it is ever fixed: a per-tab latch in `client-fetch-queue.ts` that stops handing out slots once a cell reports `rate_limited` is the smaller move; do NOT reach for a shared server-side latch across independent requests.
- [ ] [SYNC-orphan-rows] **The local mirror keeps rows that no longer exist on Apple, and nothing detects them** — `lib/iap-management/sync-states/classify.ts:46-83` only ever INSERTs or UPDATEs from Apple's list; there is no "present locally, absent from Apple" branch. Found while probing U3: `vn.lw.gg.120` / `.121` / `.123` are cached `READY_TO_SUBMIT` but `GET /v2/inAppPurchases/{id}` returns **404** — deleted on Apple, alive in `iap_mgmt.iaps`. They inflate list counts, and they nearly produced a false design conclusion (a 404 on a sub-resource read as "no availability" when the parent itself was gone). ⚠ Fix carefully: absence from ONE list response is only safe evidence if the enumeration was complete — `extractNextPagePath` (`lib/iap-management/apple/client.ts:106-117`) already throws rather than return a truncated set for exactly this reason, so a deletion-detection branch may lean on it, but must never mark rows from a partial fetch. Prefer a `missing_on_apple_since` timestamp over a hard delete.
- [ ] [UPDATE-stage1-404-redundant-price-push] `update-on-apple/route.ts:279-293` has NO 404 branch on its `getPriceScheduleForIap` call — every throw, including a stage-1 404 that simply means "this IAP has no schedule yet", is logged WARN and then forces `customPricesDiverge`, i.e. a price push that may not be needed. ⚠ THIS IS DELIBERATE AND CORRECT TODAY (P7 inverted, and its comment says so: the pricing POST is replace-all and idempotent, so re-sending is harmless while skipping a needed push silently loses the Manager's customs). Now that `NoPriceScheduleError` exists, a stage-1 404 could be recognised and the redundant push skipped — but ONLY if someone first confirms that "Apple has no schedule" and "Apple has no CUSTOM prices" are the same claim for this code path. They may not be. Left untouched by the stage-label commit on purpose; do not fold into an unrelated change.
- [ ] [VITEST-coldstart-flake-recurrence] The known vitest cold-start flake recurred, twice, during the stage-label work — and was proven PRE-EXISTING by reproducing it at `b171eeb` with the working tree stashed (1 failure in 8 baseline runs). ⚠ It is NOT a logic bug: the captured names are in unrelated modules that share nothing (`lib/iap-management/apple/submit-v2.test.ts` + `app/api/store-submissions/sync/gmail/route.test.ts`), and the root cause line is `[vitest-pool]: Failed to start forks worker … Timeout waiting for worker to respond` plus `Test timed out in 5000ms` — worker startup contention, not assertion failure. Observed rate ≈1 in 8 full-suite runs on this machine, ~3780 tests / 275 files. Prior investigation (see memory `feedback_vitest_flake_investigation.md`) closed this as capture-when-recurs; this IS the capture. Next step if it recurs again: raise `testTimeout` or cap `poolOptions.forks.maxForks` in `vitest.config`, and re-measure over 20 runs before/after. Do NOT chase individual test names — they vary by run.


## Apple rate-limit strategy (census + pre-E2 hardening, 2026-08-24/25, `ea72ab5`)

Census: `scratchpad/CENSUS-rate-limit-strategy.md` · spec/audit:
`scratchpad/P1-P3-audit-spec.md`. §4.9's cap-figure conflict is **closed by
measurement** — `user-hour-lim` = **3,600** (KB §4.9 carries the repeatable
method). Everything below is sized against that number, not against the
disproven 250/h.

- [x] ~~[RATELIMIT-parser-empty-value]~~ ✅ shipped `ea72ab5` (F1) — `Number("")` is 0, so an empty `X-Rate-Limit` component parsed as `remaining: 0` ("exhausted") instead of "unreadable".
- [x] ~~[RATELIMIT-budget-log-keyid]~~ ✅ shipped `ea72ab5` (F3) — `key=<keyId>` appended to the `[asc-client] … budget=` line.
- [x] ~~[PRICE-base-territory-silent-usa]~~ ✅ shipped `ea72ab5` (F2) — `?? "USA"` removed from `unpackPriceSchedule`.

- [ ] **[RATELIMIT-keypool-design] Key pool — 🌑 SHIPPED DARK.** Code is on `main` (K1 `77b568d` · K2 `981f408` · K3 `9322a4e`) and **inert**: `iap_mgmt.asc_account_keys` holds zero rows, so every account takes the `empty` fallback and signs with its own key exactly as before. Architecture + the two meta-rules it earned: **KB §15**. Activating it means seeding a key, not deploying anything.
  - ⏳ **CURRENT STATUS (2026-08-26): waiting on the Manager to add a real key.** The pool is still dark — `iap_mgmt.asc_account_keys` is empty — but the seeding path is now a UI, not a script (KB §15.4). Next step is entirely the Manager's: Settings → API Key Pool → Add key for one account (twice), then **Test key on each within a few seconds** and read the two `[key-pool-test]` lines for the D1 verdict. No script to run, no census file (the one this item used to cite no longer exists), no env to touch.
  - **ACTIVATION = K4, and it is a measurement, not a switch.** Manager creates a second ASC API key on one team (App Manager role — see `docs/deployment-guide.md:75`; the pool's endpoints are all app-scoped IAP metadata + pricing, so Admin is unnecessary) → seed it with `node scripts/seed-asc-pool-key.mjs --account <id> --key-id <KID> --p8 <path>` → run census D1 (11 read-only requests, `rl-lib.sh` in `scratchpad/CENSUS-rate-limit-strategy.md`) → record the verdict in KB §4.9.
  - 📓 **Manager runbook: `docs/iap-management/RUNBOOK-seed-pool-keys.md`** — step-by-step seeding for all five accounts, the self-checks that catch a mis-typed `--account`, and the D1 procedure. ⚠ **The D1 script this item used to cite is GONE**: `scratchpad/CENSUS-rate-limit-strategy.md` / `rl-lib.sh` are not on disk, not in git history and not gitignored — a session-local file that was lost. The runbook §5 reconstructs the measurement from KB §4.9 (`GET /v1/territories` is one of the endpoints that DOES return `x-rate-limit`) rather than pretending the script still exists.
  - ⚠ **IF D1 RETURNS PER-TEAM: stop, and leave the pool dark PERMANENTLY — do not rip the code out.** With an empty table the fallback path is the pre-pool path, so dark costs nothing to keep and the removal would be pure risk. `[Q-RATELIMIT.per-key-confirmed]` is the Manager's operating experience on a *different* tool: strong evidence, not a measurement of this system. §4.9 exists because Apple's docs said 3,600 and Hotfix 25 shipped 250 for months on an unread number — measurement beats confidence, including the Manager's, and that is the agreed rule rather than a hedge.
  - **`[Q-RATELIMIT.pool-scope]` — LOCKED and now structurally enforced:** the pool serves Apple IAP Management only. `appleFetch` takes an injected `AppleKeyPool` value; `iapFetch` passes one, `ascFetch` imports none and has nothing to pass. `lib/asc-client.ts` has a zero-line diff across all three commits. CPP Manager cannot enable pooling even by mistake.
  - Design census: `scratchpad/CENSUS-pool-P0.md`.
> ### 🧾 Registry sweep — TODO.md is the complete backlog registry as of **2026-08-26**
>
> Every `[TAG-name]` appearing anywhere in `docs/`, `lib/`, `app/`, `components/`,
> `supabase/` was grepped and checked against this file. Two items were found
> living **only** in a design doc / a component docstring and are now registered
> below: `[POOL-unify-availabilityReadPhase]` and `[EXPORT-resume-not-attempted]`.
> One dangling reference was corrected: KB §4.9 pointed at
> `[RATELIMIT-keypool-if-demand]` "in TODO.md", a tag that was **never registered
> anywhere** — that work is K4, under `[RATELIMIT-keypool-design]`. A duplicate
> entry was deliberately NOT created.
>
> Two tags remain outside this file **on purpose**, and are not backlog items:
> `[PRICING-429]` — shorthand citation of shipped work in two code comments; the
> item itself is registered as `[PRICING-429-no-retry]` (closed). And
> `[RATELIMIT-keypool-if-demand]` — now appears only inside the KB correction
> note that explains it was never real.
>
> ⚠ **Reproduce this sweep before trusting the registry again** (one line):
> ```
> grep -rhoE '\[[A-Z][A-Z0-9]+-[a-zA-Z0-9-]+\]' docs/ lib/ app/ components/ supabase/ \
>   | sort -u | while read t; do grep -qF "$t" TODO.md || echo "UNREGISTERED $t"; done
> ```
> `[PR-*]`, `[CPP-*]`, `[AIP-*]` are milestone/spec labels, not backlog tags — skip them.
> **The rule this enforces:** a backlog item only one surface knows about is a
> backlog item that will be missed. `SESSION-ARC-export-list-item-summary.md`
> predicted exactly that for both items registered today.

- [x] ~~**[POOL-key-management-UI] — a Settings screen for pool keys.**~~ ✅ **SHIPPED** (U1 routes · U2 screen · U3 wire+e2e). Manager pulled it off the backlog ahead of its stated opening condition — seeding five accounts by script was not acceptable for day-to-day operation, and the D1 verdict the condition waited on is now produced BY this screen rather than being a prerequisite for it. Scope v1: table per account · Add (account dropdown read from `asc_accounts`, showing `issuer_id` so a shared Apple team is visible at the moment of choosing) · Enable/Disable · **Test key**. No hard delete (disable keeps the audit trail), no editing, no display of key material. Locks: `[Q-POOLUI.no-d1-button]` (no scope-measuring button — Test key already logs it), Q1 (`AppleFetchOptions.onRateLimitInfo`, additive, byte-identical when omitted), Q2 (`key_id` shown in full — non-secret, and truncating it would break matching a row against the logs), Q3 (header link chain after Hub Tracking). ⚠ **The mockup drew a settings tab strip that does not exist**; the header-link pattern the other settings pages already use was followed instead. Architecture: KB §15.4. Runbook `docs/iap-management/RUNBOOK-seed-pool-keys.md` KEPT as the dev/emergency path. User Guide: "Quản lý API key pool".

- [ ] **[POOL-unify-availabilityReadPhase] — merge `runAvailabilityReadPhase` into `runStoppablePool`.** Two pools solve the same three-state problem (done / errored / never-attempted) under **different constraints**, and the difference is the whole reason they are still separate: `runAvailabilityReadPhase` must hold a slot from a shared *client* fetch queue, so it checks the latch **BEFORE claiming an index** (`lib/iap-management/apple/availability-read-phase.ts:118-122`) — that pre-claim check is what leaves its remainder genuinely unclaimed. `runStoppablePool` wraps `withConcurrency`, which **claims first** and lets the callback emit `skipped(item)`. Unifying means giving the pool a pre-claim hook. ⚠ **Real work, ZERO user-visible change, and it touches a shipped path** (`bulk-availability`) — which is why it is not scheduled. **Natural trigger: the next time anyone has to modify `availability-read-phase.ts`, do this instead of patching in place** — a second patch on the divergent copy is what makes the merge expensive later. Parity gate when it happens: `availability-read-phase.test.ts` must stay green unchanged. ⚠ **It has 12 tests, not ~60** — small enough that the parity gate is cheap, and worth knowing before anyone budgets the task off a remembered number. Design rationale + the constraint table: `docs/iap-management/design-export-list-item-selection.md` PART 5 (and the trade-off is written at `lib/iap-management/stoppable-pool.ts:41-48`). ⚠ **Registered here for the first time** — it previously lived in that design doc ONLY, which `SESSION-ARC-export-list-item-summary.md` had already flagged as un-greppable.

- [ ] **[EXPORT-filename-collision] — the resume export overwrites the run it is completing.** `lib/iap-management/xlsx-export.ts:509-512` stamps the filename with the DATE only, no time: `Apple-IAP-export-<appRef>-YYYYMMDD.xlsx`. So the second export of the same app on the same day downloads under an **identical name**, and the browser silently appends `(1)`. ⚠ **Why this is worse than untidy:** it lands exactly in the middle of `[EXPORT-resume-not-attempted]`'s workaround — a Manager exports, gets rate-limited, re-exports the remainder, and now holds two same-named files they must merge in the right order. Getting that pair backwards produces a plausible-looking workbook that is missing rows. **Fix: add `HHmmss` to the stamp.** Scope ~XS: one line, plus any test pinning the filename shape (`grep -rn "Apple-IAP-export" lib/ --include=*.test.ts` before editing). ⚠ **When this ships, DELETE the temporary warning it makes obsolete** — `docs/user-docs/index.html`, `apple-iaps` page, the tip *"Export lại phần còn thiếu: bạn tự ghép file"*, final paragraph beginning *"⚠ Cẩn thận khi đặt tên file"*. A stale warning about a fixed bug teaches users to distrust the guide. Found while writing that guide section (`6ffbe1a`), not by a user report.

- [ ] **[EXPORT-resume-not-attempted] — "export the rest" button.** When an export stops on Apple's rate limit, the remainder is listed in the `Export Failures` sheet as `Not attempted` but there is no one-click way to fetch just those. ⚠ **Registered here for the first time** — it previously lived ONLY in the `ExportResultSummary` docstring, which `SESSION-ARC-export-list-item-summary.md` had already flagged as un-greppable from TODO.md. Blocked on the remainder's ids not being on the wire at the point the summary renders. **v1 workaround documented in User Guide (`apple-iaps` → A4 `Not attempted` row + the "Export lại phần còn thiếu" tip):** filter the sheet for `Not attempted` → wait ~1h → re-tick exactly those in the Export list wizard → export → merge the two files by hand. ⚠ The guide also warns that the filename carries the DATE only, so a same-day resume downloads under a colliding name. Anyone building the real button should read that tip first — it is the behaviour users will have learned.

- [ ] **[EXPORT-merge-stage1-into-detail] (E3) — VERIFIED BROKEN AS DESIGNED · DEFERRED.** Proposal was to drop the price-schedule Stage 1 by side-loading `?include=iapPriceSchedule` off the IAP detail read (3 → 2 Apple requests per exported item, −33%). **Measured live 2026-08-25** against `6804564022` (account `vnggames-co-ltd`), 2 read-only GETs, script in `scratchpad/P1-P3-audit-spec.md` PART P3:

    ```
    [GATE 1] scheduleId from PRIMARY resource   : 6804564022      ✅ PASS
             relationships.iapPriceSchedule keys: ["data","links"]
    [GATE 2] schedule present in included[]     : true            ✅ PASS
    [GATE 3] baseTerritory KEYS                 : ["links"]       ❌ FAIL
    [GATE 4] baseTerritory.data.id              : *** links only ***
    (control) current Stage 1 → baseTerritory id: USA             — Stage 1 does return it
    ```

    **The predicted trap fired exactly as predicted.** JSON:API gives resources in `included[]` relationships that carry `links` and no `data` ids — the rule already written down in this repo's CLAUDE.md (the CPP screenshot-set quirk). Side-loading the schedule moves it out of primary position, and `baseTerritory` stops being readable. Export uses that value in two places (`xlsx-export.ts:206` → workbook column; `iap-detail.ts:271` → `basePrice` lookup), so the merge as designed would produce rows with no base territory. ⚠ Note that **GATE 1 passed**: `scheduleId` IS available from the primary resource, so Stage 1 is droppable *if a second source for `baseTerritory` is found* — that is a new design, not a tweak, and it must not lean on the observation that `scheduleId === appleIapId` in this sample (an Apple id coincidence, not a documented rule).
    ⚠ **Subject had `base_territory = "USA"`** — no non-USA IAP exists in the mirror (200/200 are USA). This matters less than it did when P3 was written: F2 removed the `?? "USA"` fallback, so GATE 4 is now a purely structural question (`data.id` present or absent) and its answer does not depend on the value. Re-run on a non-USA base if one ever appears, to close the last sliver.
    **Deferred by Manager decision** — the key pool solves the budget problem, and E3 raises budget efficiency, not speed. ⚠ **Raise priority again if EITHER:** (a) production `budget=` lines show real demand hitting the ceiling *after* the pool ships, or (b) large-job WALL-CLOCK time becomes the complaint — the pool adds budget but does not remove round-trips, and E3 removes ~33% of them. **Do not delete the P3 script.**
- [ ] **[RATELIMIT-e2-budget-pacing] Read `user-hour-rem` live and stop bulk jobs at a budget floor instead of at Apple's 429.** Spec: `scratchpad/P1-P3-audit-spec.md` PART P2. Cut-in point is one line (`lib/shared/apple-fetch.ts:235` — `budget` is already parsed there); `RESERVE = max(0.10 × lim, 50)` = **360**. ⚠ Value is *not* rescuing export (3,600/h is comfortable at N=500) — it is protecting the ~360 requests a Manager's interactive clicks need while a bulk job runs; today the third export in an hour burns those too before the latch trips. ⚠ Two costs the spec names honestly: `StoppablePoolResult.stopped: boolean` must become a `stoppedReason` (2 pool callers), and `xlsx-export.ts:322` hard-codes *"rate limit reached"* for `NOT_ATTEMPTED` — a lie once a pause can also cause it. ⚠ **Sequence after `[BACKLOG-latch-bulk-write]`,** not before.
- [x] ~~**[BACKLOG-latch-bulk-write] — submit-batch half**~~ ✅ shipped (C1) — `submit-batch` legacy write loop now uses `runStoppablePool`; new `NOT_ATTEMPTED` result status, kept strictly distinct from `SKIPPED_BY_STATE_GUARD`. `bucket.ts` untouched (zero-line diff, 16/16 unmodified). **Bulk Import remains open — see C2/C3 below.**
- [ ] **[SUBMIT-v2-no-latch] The v2 submit path has no stop latch, and `not_attempted` is always 0 there.** `executeSubmitV2` (`lib/iap-management/apple/submit-v2.ts:183-193`) walks its items in a plain `for` loop with per-item `withRetry` and nothing that stops dispatching — the exact shape C1 removed from the legacy path. It is a **different shape**, not a copy-paste target: one shared reviewSubmission, multi-phase, client-orchestrated across round-trips, so a rate-limit stop has to decide what happens to a half-populated submission container (leave it? roll it back? the `rollbackOrLeaveSubmitV2` machinery already exists and would be the hook). ⚠ **Not urgent today for exactly one reason: v2 is OFF by default** — `IAP_SUBMIT_V2_APPS` unset ⇒ every app takes the legacy path, which C1 hardened. ⚠ **ACTIVATION CONDITION: do this BEFORE setting `IAP_SUBMIT_V2_APPS` for any app, including a single dogfood id.** The moment one app is allowlisted, that app's submits run unlatched, and the rate-limit blast radius is a shared review submission rather than one row. Treat flipping the toggle and closing this item as the same task.
### ⏳ UAT PENDING — latch arc C1 → C2 → PRICING-429 → C3 (Manager runs by hand)

⚠ **Nothing below is verified in production.** Every claim in this group is
backed by tests and mutations only. Two migrations (`20260826000000`,
`20260827000000`) must be applied and their verify queries pass BEFORE the
deploy that carries this code — G2 ordering, schema first.

⚠ **U4 and U5 are the two that can only be checked by a human**, because they
are about whether the sentence on screen matches what a Manager believes
happened. The rest could in principle be automated; these cannot.

| # | Scenario | Expected | Catches |
|---|---|---|---|
| **U1** | Import a small CLEAN batch (2–3 rows, all fields present) | Every row `success`. Tally shows the familiar **three** tiles — no "Partial", no "Not sent". `import_batches`: `created_count` = row count, `partial_count = 0` | C3 did not change the happy path; the conditional tiles stay conditional |
| **U2** | Same batch, one row's screenshot file **deliberately corrupt** | That row `partial` (amber ⚠ badge, NOT red). Its Notes cell shows a summary + **Detail**; expanding lists all six stages with `Screenshot  failed`. Other rows unaffected — the batch does **not** halt | The row/stage distinction, and Rule 2 (one bad file ≠ a halted batch) |
| **U3** | U2's row: check `Outcome` and `Price` columns | Both show real values (e.g. `Created + submitted`, `Price set`) — **NOT** `—` | The chunk-A debt chunk B repaid: a PARTIAL row must show what it DID achieve |
| **U4** | **Re-run the same file** without changing anything | Step 3 shows the U2 product as a conflict row carrying **last run's sentence** under its product id (amber ⚠). Clean rows carry **nothing**. The Action control reads the same on both | [Q-C3.conflict-read-B] — and that a clean row is not decorated |
| **U5** | An IAP currently **in Apple review**, re-imported with a new screenshot | Row `partial`, summary reads **`screenshot locked by Apple review`** — not `missing screenshot`. Orange "screenshot locked" pill agrees with the badge | W2. ⚠ The pill and the status used to CONTRADICT each other; this is the check that they now agree |
| **U6** | After U2, query the mirror | `SELECT product_id, last_import_status, last_import_summary FROM iap_mgmt.iaps WHERE app_id = …` → the PARTIAL row is **present** with `last_import_status='PARTIAL'` and a sentence | PARTIAL counts as a write that happened; catches `[SYNC-orphan-rows]` in reverse |
| **U7** | After U2, query the batch | `SELECT created_count, partial_count, failed_count, not_attempted_count, status FROM iap_mgmt.import_batches ORDER BY imported_at DESC LIMIT 1` → `partial_count ≥ 1`, `created_count` **includes** it, `status` still `COMPLETE` | C-2, and that the status is frozen **on purpose** |
| **U8** | ⚠ **Opportunistic — only if Apple actually throttles.** A large batch that hits a real 429 surviving retry | Later rows `not sent` (dashed slate) + the banner. The stopping row shows `stopped by rate limit before …` naming the stages, and `Price` reads **`Not sent`**, not red `Not ready` | The whole latch chain, and the borrowed-`skipped-not-ready` kind not being rendered as a poll-window timeout |

**If U4 shows nothing on a known-PARTIAL row:** most likely the migration ran
after the batch, so the row has no cached verdict. `actions_log` still has the
truth — `SELECT payload->>'summary' FROM iap_mgmt.actions_log WHERE
action_type='BULK_IMPORT_CREATE' ORDER BY created_at DESC LIMIT 5` — and the
cache fills on the next import. Not a bug; the ordering consequence named in
the migration comment.

- [x] ~~**[BACKLOG-latch-bulk-write] — bulk-import half**~~ ✅ shipped (C2) — outer latch via `runStoppablePool` + `shouldStopOnResult`; `trackedWithRetry` sets `counters.exhausted` at ONE choke point when an `AppleRateLimitError` survives retry, and the pool reads it off the returned result. Migration `20260825000000` (`not_attempted_count`) applied. ⚠ `NOT_ATTEMPTED` means *"Apple was never asked, safe to re-run"* — true only while a row is a single write, which C3 then made false at the STAGE level and answered with PARTIAL (below). **Group closed: both halves shipped.**

- [x] ~~**[PRICING-429-no-retry] the pricing stage swallowed its own rate limits**~~ ✅ shipped (`3b4c81a`, PA-C) — `setPriceSchedule` returns `{ok:false}` rather than throwing, so wrapping it in `withRetry` was a no-op and a 429 there was invisible to C2's latch. Fixed by CLASSIFYING at the source (`classifyPricingFailure`, shared by the read and write paths) and carrying `failure_kind` on `PricingOutcome` — **not one attempt was added or removed.** The blanket catch at `pricing-orchestration.ts:207` stays (NEVER-cascade contract) but now classifies before flattening. A surviving 429 in the pricing stage reaches the latch **through the result**, not through a throw.

- [x] ~~**[C3] a bulk-import row asserted SUCCESS while five of six stages swallowed their errors**~~ ✅ shipped (chunk A `8ff16fe` → C-3 `59ded5a`). Three distinct defects, all closed:
  1. **Fake SUCCESS** — both terminal returns were a hard-coded `status: "SUCCESS"`. The row's status is now DERIVED from a per-stage map (`rollUpRowOutcome` is the only decider), so status and map cannot disagree. OVERWRITE hardened too, with a deliberately NON-identical map (`NOT_APPLICABLE` where the path genuinely does not run that stage).
  2. **The locale loop marched on through a spent budget** — a 429 that had already burned four retries on locale #k continued through #k+1…#39 at four attempts each, ~156 requests per row aimed at an API that had just refused. Now breaks on `rateCounters.exhausted` **and only on that**: a single locale failing validation still `continue`s, pinned by two tests and two opposing mutations.
  3. **The dead ternary was bypassed, not removed** — see `[BULKIMPORT-dead-ternary]` below.
  Migrations `20260826000000` (`partial_count`) and `20260827000000` (`iaps.last_import_*`) — ⚠ see UAT PENDING below before treating as verified in production.

- [x] ~~**[BULKIMPORT-dead-ternary] `import_batches.status` writes `failed === 0 ? "COMPLETE" : "COMPLETE"`**~~ ✅ **closed as a DECISION, not as a fix — the ternary is deliberately left exactly as it is.** [Q-C3.tracking-frozen]: the Manager froze every tracking/batch-level status for C3, so `status` is *supposed* to be constant here and the new truth travels through `partial_count` instead. Collapsing the ternary to a plain `"COMPLETE"` would be harmless in itself but would remove the visible oddity that prompts a reader to look up WHY — and the next person who "finishes the job" by making it a real status change breaks the freeze. **This is no longer a defect. Do not open it again without the Manager reopening [Q-C3.tracking-frozen].**

- [ ] **[BACKLOG-latch-bulk-write] `bulk-import/execute` and `submit-batch` have `withRetry` but NO stop latch.** Census C1: `export` and `bulk-availability` both stop dispatching when a 429 survives retry (`runStoppablePool`); these two do not — the row fails and the orchestrator keeps firing the rest of the batch into an API that is already refusing. ⚠ **This is a live gap at any cap figure** — it does not depend on E2, on the 3,600 measurement, or on anything else in this section. Highest priority of the group.
