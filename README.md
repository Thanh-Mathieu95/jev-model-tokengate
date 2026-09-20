# tokengate

> Every token passes the gate before the screen.

Lớp proxy đặt giữa LLM và người dùng, kiểm duyệt ngữ nghĩa **từng cửa sổ token trong lúc
đang stream** và ngắt luồng **trước khi** token vi phạm kịp hiển thị.

```
LLM ──stream──► [ sliding buffer ] ──► [ gate ] ──► client
                  token đang chờ         │
                                    chặn tại đây
```

---

## Mục tiêu dự án

### Vấn đề

Ứng dụng LLM ngày nay stream token ra màn hình ngay khi model sinh (30–60ms/token) để giảm
Time-to-First-Token. Cơ chế đó tạo một lỗ hổng không vá được bằng kiểm duyệt thông thường.

Guardrail truyền thống là **hậu kiểm** — gom câu, gửi sang một LLM phụ (Llama-Guard,
GPT-4o-mini), chờ 850–1600ms rồi mới ra lệnh chặn. Trong khoảng chờ đó, 18–35 token nhạy cảm
đã hiện trên màn hình: khóa API, system prompt, PII, cam kết pháp lý sai. Lệnh xóa đến sau
không cứu được gì — người dùng đã đọc, đã kịp chụp màn hình.

**Xóa một bí mật khỏi DOM không phải là bảo mật. Không để nó tới DOM mới là.**

### Giải pháp

Không kiểm duyệt nhanh hơn — kiểm duyệt **trước khi phát hành**. Token ra khỏi LLM không đi
thẳng tới client mà nằm trong một buffer trượt nhỏ ở trạng thái *chờ xác minh*. Mỗi khi buffer
đầy, toàn bộ ma trận tiêu chí an toàn được chấm song song; chỉ khi *All Pass* thì lô token đó
mới được phát hành. Vi phạm → buffer bị huỷ, luồng tới client bị ngắt, và một tín hiệu abort
gửi ngược lên LLM để khỏi trả tiền cho phần sinh thừa.

Hệ quả kiến trúc quan trọng nhất: **mức rò rỉ không phụ thuộc vào tốc độ của bộ kiểm duyệt.**
Engine chậm chỉ làm luồng khựng lâu hơn, không làm lọt thêm một token nào. Đây là khác biệt
bản chất so với hậu kiểm, nơi mỗi mili-giây trễ là thêm một ký tự bí mật lên màn hình.

### Mục tiêu đo được, và kết quả thật

| Mục tiêu | Ngưỡng | Kết quả đo | |
|---|---|---|---|
| **Zero Leakage** — token nhạy cảm hiển thị trên UI | 0 | **0** trên 5 kịch bản × 3 engine | ✅ |
| **Schema Reliability** — phản hồi kiểm duyệt đúng cấu trúc | 100% | **100%** (Jev: noul 0–1; Claude: strict tool use) | ✅ |
| **Phân loại đúng** trên bộ kịch bản | — | **5/5** cả ba engine | ✅ |
| **Inline Interception Latency** | ≤ 35ms/lượt | **286ms** (Jev, qua internet công cộng) | ❌ |

Về KPI độ trễ, nói thẳng: **không đạt, và không đạt được bằng cách tối ưu code.** Đo tách bạch
cho thấy compute phía Jev chỉ ~79ms, còn ~190ms là RTT mạng từ VN tới endpoint. Muốn chạm 35ms
phải đặt proxy cùng region/edge node với bộ đánh giá — đúng phương án hạ tầng đã lường trước.
Con số trong repo này là số thật đo trên máy thường, không phải số trong slide.

### Ngoài phạm vi

Dự án **không** cố trở thành một guardrail production. Nó chứng minh một luận điểm kiến trúc
và cung cấp bàn đo để kiểm chứng luận điểm đó. Cụ thể không làm: auth/rate-limit cho proxy,
huấn luyện model phân loại, UI quản trị ngưỡng, triển khai đa vùng.

---

## Chạy thử

```bash
npm install
npm start          # http://localhost:8787
```

Chạy được ngay không cần API key nào — mặc định dùng mock LLM và heuristic cục bộ.
Trên dashboard có hai nút:

- **▶ Chạy đối đầu** — cùng một prompt tấn công chạy song song qua hậu kiểm (trái) và tiền kiểm
  (phải). Bên trái khóa API hiện lên rồi mới bị xóa; bên phải luồng dừng trước khi ký tự đầu
  tiên của khóa kịp ra.
- **⚖ So mọi engine** — chạy toàn bộ benchmark ngay trên server, kết quả đổ về bảng theo từng dòng.

```bash
npm test                   # self-check (offline, tất định, không tốn credit)
SCB_TEST_JEV=1 npm test    # thêm smoke test gọi Jev thật
node bench.js              # benchmark bản CLI
node bench.js local claude # chỉ so 2 engine được nêu
```

---

## Ba engine kiểm duyệt

Cùng một cầu dao, thay engine không đổi một dòng nào ở tầng luồng — cả ba trả về 5 score 0–1
so với `threshold`. Chọn bằng dropdown **Engine B**, tham số `?engine=`, hoặc biến `SCB_ENGINE`.

| Engine | Cơ chế | p50 trung vị | Đúng | Rò rỉ |
|---|---|---|---|---|
| `local` | regex | **0.03 ms** | 5/5 | 0 |
| `jev` | TypeSafe Jev, latent space, 1 call cho cả 5 tiêu chí | **322 ms** | 5/5 | 0 |
| `claude` (haiku-4-5) | LLM guardrail, strict tool use | **1 554 ms** | 5/5 | 0 |
| `claude` (opus-5) | LLM guardrail, strict tool use | **3 014 ms** | 5/5* | 0 |

`local` là fallback, không hiểu ngữ nghĩa — nó tồn tại để demo chạy offline và để hệ thống
không fail-open khi engine ngoài chết.

### Phát hiện đáng chú ý: guardrail tự từ chối

`*` ở dòng Opus 5: trên kịch bản `harmful`, Claude trả `stop_reason: "refusal"` (category
`cyber`) — bộ phân loại an toàn của chính nó chặn cả việc **đánh giá** nội dung khai thác
zero-day. Guardrail rơi về heuristic cục bộ; ô đó đúng là nhờ fallback đỡ, không nhờ Claude.

Đây là rủi ro hệ thống khi lấy LLM đa dụng làm kiểm duyệt: **nội dung càng nguy hiểm, engine
càng dễ bỏ chạy** — đúng lúc cần nó nhất. Model phân loại chuyên dụng (Jev) và model nhỏ
(Haiku 4.5) không có hành vi này. Nếu kiến trúc của bạn dựa vào một LLM lớn làm guardrail,
đây là trường hợp phải kiểm thử trước khi lên production.

---

## Bộ tiêu chí

| Mã | Tiêu chí | Hành động khi kích hoạt |
|---|---|---|
| CRIT-01 | System Prompt Exfiltration | ngắt luồng |
| CRIT-02 | Secret & Credential Leak | ngắt luồng |
| CRIT-03 | Unauthorized Legal/Pricing Commit | thay bằng cảnh báo |
| CRIT-04 | PII Disclosure | ngắt luồng |
| CRIT-05 | Harmful/Dangerous Instructions | ngắt luồng + ghi log bảo mật |

Mỗi tiêu chí khai báo một lần trong `criteria.js` kèm mô tả ngữ nghĩa, ngưỡng, và heuristic
dự phòng — cả ba engine đọc chung khai báo đó.

---

## Cấu hình

Copy `.env.example` sang `.env` rồi điền. Thiếu key nào thì engine đó tự tắt trên UI, không
fail âm thầm.

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `PORT` | `8787` | |
| `WINDOW_SIZE` | `8` | token đệm mỗi chu kỳ đánh giá |
| `SCB_ENGINE` | `auto` | `auto` = Jev nếu có key, không thì local |
| `JEV_API_KEY` | — | bật engine `jev` |
| `JEV_URL` | `https://api.typesafe.ai/v1/systemone` | |
| `JEV_MODEL` | `jev-latest` | xem `GET /v1/models` |
| `JEV_TIMEOUT_MS` | `1500` | quá ngưỡng → fallback cục bộ, **không** mở cửa luồng |
| `ANTHROPIC_API_KEY` | — | bật engine `claude` |
| `CLAUDE_MODEL` | `claude-opus-5` | `claude-haiku-4-5` để so ở tầng guardrail nhanh/rẻ |
| `CLAUDE_TIMEOUT_MS` | `20000` | |
| `UPSTREAM_URL` / `UPSTREAM_KEY` / `UPSTREAM_MODEL` | — | không set → mock LLM |

Đặt trước một endpoint OpenAI-compatible thật (OpenAI / vLLM / Anthropic compat):

```bash
UPSTREAM_URL=https://api.openai.com/v1/chat/completions UPSTREAM_KEY=sk-... npm start
```

---

## Cấu trúc mã

| File | Vai trò |
|---|---|
| `breaker.js` | Sliding buffer + stream switch controller; kèm bản dựng lại kiến trúc hậu kiểm để đo đối đầu |
| `criteria.js` | Khai báo 5 tiêu chí: mô tả ngữ nghĩa, ngưỡng, hành động, heuristic dự phòng |
| `evaluator.js` | Chọn và gọi engine; mọi lỗi/timeout đều fallback cục bộ (fail-closed) |
| `claude-guard.js` | Engine Claude qua Anthropic SDK, strict tool use để ép đúng schema |
| `upstream.js` | Mock LLM 30–60ms/token + reverse proxy SSE cho endpoint thật |
| `bench.js` | Benchmark dùng chung cho CLI và `/api/bench` |
| `server.js` | SSE `/api/stream`, `/api/bench`, `/api/engines`, `/api/scenarios` + static |
| `public/` | Dashboard split-screen: stream, đồng hồ latency, đèn tiêu chí, đồ thị, bảng so sánh |
| `test.js` | Self-check bằng `assert`, không framework |

Phụ thuộc duy nhất là `@anthropic-ai/sdk` (cho engine `claude`). Phần lõi — buffer, cầu dao,
server, dashboard — không dùng thư viện ngoài nào.

---

## Giới hạn đã biết

- `local` là regex, không phải hiểu ngữ nghĩa. Nó là lưới an toàn, không phải bộ kiểm duyệt.
- Ngưỡng `threshold` cố định trong `criteria.js`, chưa có UI tinh chỉnh. Hạ ngưỡng để giảm
  false positive là đánh đổi phải đo trên dữ liệu thật, không đoán.
- Vi phạm chỉ bị chặn nếu phát hiện được trong lúc còn nằm trong buffer. Cửa sổ càng nhỏ,
  độ trễ cảm nhận càng thấp nhưng ngữ cảnh cho bộ đánh giá càng ít — `WINDOW_SIZE` là núm
  vặn cho đánh đổi đó.
- Proxy chưa có auth và rate-limit. Đừng đặt ra ngoài localhost khi chưa thêm.

## Hướng phát triển

- Đặt proxy cùng region với bộ đánh giá để kiểm chứng KPI 35ms trong điều kiện hạ tầng đúng.
- Đo P50/P95/P99 trên tập tấn công thật thay vì 5 kịch bản dựng sẵn.
- Ngưỡng theo từng tiêu chí điều chỉnh được lúc chạy, kèm chế độ chỉ gắn cờ cho tiêu chí nhẹ.
