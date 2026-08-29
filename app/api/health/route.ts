/**
 * GET /api/health — Railway healthcheck target.
 *
 * ─── VÌ SAO ROUTE NÀY TỒN TẠI ──────────────────────────────────────────────
 *
 * Healthcheck của Railway trước đây trỏ `/`. Nhưng `/` là
 * `app/(dashboard)/page.tsx`, và nó `redirect("/login")` khi không có
 * session — từ commit đầu tiên (`c922f83`, 2026-03-12). Healthcheck không
 * mang cookie, nên nó LUÔN nhận 307, không bao giờ nhận 2xx.
 *
 * Route này trả 200 phẳng, không auth, để healthcheck hỏi đúng câu hỏi nó
 * cần hỏi.
 *
 * ─── ⚠ KHÔNG ĐƯỢC CHẠM DB. ĐÂY LÀ CHỦ ĐÍCH, KHÔNG PHẢI THIẾU SÓT ──────────
 *
 * Healthcheck trả lời đúng một câu: **tiến trình còn sống và còn nhận được
 * request HTTP không.** Nó KHÔNG trả lời "toàn hệ thống có khoẻ không".
 *
 * Nếu route này query Supabase, thì một sự cố phía Supabase — hoặc chỉ một
 * đợt chậm — sẽ làm healthcheck fail, và Railway sẽ **giết một container
 * đang chạy hoàn toàn bình thường**, rồi khởi động lại nó vào đúng cái sự cố
 * đó. Một phụ thuộc ngoài tầm kiểm soát biến thành một vòng lặp tự sát: đúng
 * lúc hệ thống cần ổn định nhất thì nó bị restart liên tục.
 *
 * Cùng lý do: không đọc env, không import `authOptions`, không import bất kỳ
 * client DB nào. `app/api/health/route.structure.test.ts` ép điều đó bằng
 * test, vì "đừng thêm DB vào đây" là loại lời dặn mà người sau sẽ vi phạm
 * với ý tốt ("healthcheck nên kiểm cả DB chứ").
 *
 * Muốn một endpoint trả lời "hệ thống có khoẻ không" thì làm route RIÊNG
 * (`/api/readiness` chẳng hạn) và ĐỪNG trỏ healthcheck của Railway vào nó.
 *
 * ─── KHÔNG BỊ AUTH BỌC ─────────────────────────────────────────────────────
 * Repo không có `middleware.ts` (chưa từng có — `git log --diff-filter=D`
 * rỗng), và Route Handler không bị `layout.tsx` bọc. Mọi route khác dưới
 * `app/api/` tự gọi guard của chính nó (`requireIapSession`,
 * `getServerSession`, header `X-Cron-Secret`…). Route này cố ý không gọi gì.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // Healthcheck không được đọc phải một bản cache.
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
