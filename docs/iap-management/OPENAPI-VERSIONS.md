# ⚠ ĐỌC TRƯỚC KHI TRA OpenAPI CỦA APPLE

Repo có **HAI** bản snapshot spec, và **bản nằm ngay trong thư mục này là bản CŨ.**

| File | `info.version` | Dùng khi nào |
|---|---|---|
| `docs/openapi.oas.v20260717.json` | **4.4.1** | ⭐ **BẢN CHUẨN — tra ở đây trước** |
| `docs/iap-management/openapi.oas.json` | **4.3.1** | chỉ để đối chiếu lịch sử / xem 4.4.1 đã thêm gì |

## Vì sao có cảnh báo này

Đây là một **bẫy tra cứu**, không phải bẫy code — không dòng code nào đọc hai
file này lúc chạy, nên không có test nào bắt được nó. Nó chỉ cắn người.

Bản 4.3.1 nằm trong thư mục của module IAP, nên phản xạ tự nhiên là mở nó. Và
nó **thiếu hẳn** những nhánh quyết định:

| Thứ cần tra | 4.4.1 | 4.3.1 |
|---|---|---|
| `/v2/inAppPurchaseLocalizations` (POST) | ✅ | ❌ **không có** |
| `/v2/inAppPurchaseLocalizations/{id}` (GET/PATCH/DELETE) | ✅ | ❌ **không có** |
| `/v1/inAppPurchaseVersions*` (8 path) | ✅ | ❌ **0 path** |
| `/v2/inAppPurchases/{id}/versions` | ✅ | ❌ **không có** |
| `InAppPurchaseV2.relationships.versions` | ✅ | ❌ **không có** |

⇒ Ai chỉ mở bản 4.3.1 sẽ kết luận **"Apple không có API này"** — và kết luận đó
sai. Toàn bộ mô hình version của in-app purchase được thêm vào ở **4.4.1**.

## Cách tra cho đúng

Grep theo **path key trong object `paths`**, đừng grep văn xuôi:

```bash
python3 -c "
import json; d=json.load(open('docs/openapi.oas.v20260717.json'))
print(d['info']['version'])
for p in sorted(d['paths']):
    if 'inapppurchase' in p.lower():
        print(p, sorted(m.upper() for m in d['paths'][p] if m in ('get','post','patch','delete')))
"
```

⚠ Hit trong `description` trông **y hệt** hit thật. Luôn kiểm `info.version`
của file trước khi tin kết quả.

⚠ **Và spec không mô tả đủ hành vi thật.** Ba tiền lệ đã đo: 409 duplicate
product-id, 409 `ACTIVE` localization (state này **không có** trong enum của
spec), và `DELETE /v1/reviewSubmissions/{id}` — endpoint mà CPP đang dùng thật
nhưng **cả hai bản spec đều không liệt kê**. Spec im lặng **không** chứng minh
điều gì không tồn tại.

## Việc còn treo — cần Manager chốt

Xem `TODO.md` mục `[OAS-two-snapshots]`.
