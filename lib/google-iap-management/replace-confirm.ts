/**
 * G1c/C5 — QUYẾT ĐỊNH biến thể của modal xác nhận Replace.
 *
 * Tách thành hàm thuần, KHÔNG để inline trong JSX, vì đây là một quy tắc
 * nghiệp vụ có thể sai theo đúng một kiểu rất khó thấy khi đọc lướt:
 * phân biệt "bản máy nhân bản" với "bản người thật upload".
 *
 * ⚠ ĐIỀU KIỆN LÀ `origin_note !== null`. TUYỆT ĐỐI KHÔNG so
 *   `uploaded_by === "SYSTEM_MIGRATION"`. Hai lý do, cả hai đều thật:
 *
 *   1. `uploaded_by` là DỮ LIỆU NGƯỜI DÙNG NHẬP ĐƯỢC — route ghi thẳng
 *      `session.user.email` vào đó. Nó là một cái tên, không phải một cờ
 *      hệ thống. Lấy một cái tên ra làm cờ nghĩa là ai mang đúng tên đó
 *      sẽ được xử lý như máy.
 *
 *   2. `origin_note` mang ĐÚNG mệnh đề cần hỏi: "bản này do migration
 *      nhân bản, chưa ai cấu hình riêng cho account". Và nó TỰ HẾT HIỆU
 *      LỰC đúng lúc: `replaceTemplate` sinh bản mới với `origin_note`
 *      NULL, nên ngay sau lần Replace đầu tiên nhãn "bản sao" biến mất mà
 *      không cần ai đi dọn cờ.
 *
 * Hệ quả nếu chọn nhầm cột: modal hiện màu XANH "chưa ai cấu hình riêng"
 * ngay trước khi ghi đè công sức thật của một người — đúng cái mà lời
 * cảnh báo sinh ra để chặn.
 */
export type ReplaceConfirmVariant = "untouched-clone" | "human-authored";

export function replaceConfirmVariant(template: {
  origin_note: string | null;
}): ReplaceConfirmVariant {
  return template.origin_note !== null ? "untouched-clone" : "human-authored";
}
