/**
 * `/api/health` — hành vi + guard cấu trúc.
 *
 * Hai loại test, hai lý do khác nhau:
 *   • hành vi  — trả 200, không session, không header gì đặc biệt.
 *   • cấu trúc — file KHÔNG được import DB/auth. Đây mới là phần dễ hỏng:
 *     "healthcheck nên kiểm cả DB chứ" là một ý tưởng nghe rất hợp lý, và
 *     người thêm nó sẽ không biết rằng mình vừa cho Railway quyền giết
 *     container mỗi khi Supabase hắt hơi.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { GET } from "./route";

describe("/api/health — hành vi", () => {
  it("trả 200 mà KHÔNG cần session", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("không cache — healthcheck phải hỏi lại mỗi lần", () => {
    expect(GET().headers.get("cache-control")).toMatch(/no-store/);
  });

  it("là hàm đồng bộ, không await gì — không có gì để mà treo", () => {
    // Một healthcheck `async` chờ I/O là một healthcheck có thể timeout vì
    // lý do không liên quan tới việc tiến trình còn sống hay không.
    expect(GET()).toBeInstanceOf(Response);
  });
});

describe("/api/health — guard cấu trúc: KHÔNG chạm DB/auth", () => {
  const SOURCE = readFileSync(join(__dirname, "route.ts"), "utf8");
  /** Bỏ comment: file này CỐ Ý nhắc tên `authOptions`, `Supabase`… trong
   *  phần giải thích vì sao không dùng chúng. Cấm nhắc là ép người sau xoá
   *  chính lời giải thích để làm test xanh. */
  const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const FORBIDDEN = [
    "@/lib/iap-management/db",
    "@/lib/supabase",
    "@/lib/store-submissions/db",
    "@/lib/google-iap-management/db",
    "@/lib/auth",
    "next-auth",
    "@supabase/supabase-js",
    "@/lib/asc-account-repository",
    "@/lib/get-active-account",
  ];

  it("không import DB, không import auth", () => {
    const hits = FORBIDDEN.filter((mod) => CODE.includes(mod));
    expect(
      hits,
      hits.length === 0
        ? ""
        : `\n\n/api/health vừa được nối vào: ${hits.join(", ")}\n\n` +
          "Healthcheck chỉ trả lời 'tiến trình còn sống', KHÔNG phải 'hệ thống\n" +
          "khoẻ'. Nối nó vào DB nghĩa là một sự cố Supabase sẽ khiến Railway\n" +
          "GIẾT container đang chạy tốt, rồi restart nó vào đúng sự cố đó.\n" +
          "Cần endpoint kiểm sâu thì làm route RIÊNG và đừng trỏ healthcheck\n" +
          "của Railway vào nó.\n",
    ).toEqual([]);
  });

  it("không có import statement nào ngoài kiểu (file phải tự đứng)", () => {
    const imports = CODE.match(/^\s*import\s.+$/gm) ?? [];
    expect(imports, `Import không mong đợi: ${imports.join(" | ")}`).toEqual([]);
  });

  it("không đọc process.env — env thiếu không được làm healthcheck đỏ", () => {
    expect(CODE).not.toMatch(/process\.env/);
  });

  it("SELF-CHECK: scanner còn đọc được file thật", () => {
    // Nếu đường dẫn sai hoặc file đổi tên, mọi assert trên PASS RỖNG.
    expect(SOURCE.length).toBeGreaterThan(200);
    expect(CODE).toMatch(/export function GET/);
  });
});
