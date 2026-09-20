# tokengate

> Every token passes the gate before the screen.

Lớp proxy đặt giữa LLM và người dùng, kiểm duyệt ngữ nghĩa **từng cửa sổ token trong lúc
đang stream** và ngắt luồng **trước khi** token vi phạm kịp hiển thị.

```
LLM ──stream──► [ sliding buffer ] ──► [ gate ] ──► client
                  token đang chờ         │
                                    chặn tại đây
```

![tokengate race benchmark](docs/race.png)

Cùng một prompt tấn công, hai kiến trúc chạy song song. **Trái (hậu kiểm):** khóa API
`sk-proj-...` và `DB_PASSWORD` hiện đầy đủ trên màn hình, 2.98 giây sau mới có thông báo
"Nội dung đã bị xóa" — 173 ký tự đã lộ. **Phải (tokengate):** luồng ngắt ngay trong buffer,
**0 ký tự rò rỉ**.

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
| **Inline Interception Latency** | ≤ 35ms/lượt | **~300ms** (Jev, qua internet công cộng; đo lặp 277–345ms) | ❌ |

Về KPI độ trễ, nói thẳng: **không đạt, và không đạt được bằng cách tối ưu code.** Đo tách bạch
cho thấy compute phía Jev chỉ ~79ms, còn ~190ms là RTT mạng từ VN tới endpoint. Muốn chạm 35ms
phải đặt proxy cùng region/edge node với bộ đánh giá — đúng phương án hạ tầng đã lường trước.
Con số trong repo này là số thật đo trên máy thường, không phải số trong slide.

### Ngoài phạm vi

Dự án **không** cố trở thành một guardrail production. Nó chứng minh một luận điểm kiến trúc
và cung cấp bàn đo để kiểm chứng luận điểm đó. Cụ thể không làm: auth/rate-limit cho proxy,
huấn luyện model phân loại, UI quản trị ngưỡng, triển khai đa vùng.

---

## Cắm vào ứng dụng có sẵn

Dựng proxy:

```bash
docker build -t tokengate . && docker run -p 8787:8787   -e JEV_API_KEY=...   -e UPSTREAM_URL=https://api.openai.com/v1/chat/completions   tokengate
```

Rồi sửa **đúng một dòng** trong ứng dụng đang có:

```python
client = OpenAI(base_url="http://localhost:8787/v1")   # thay vì api.openai.com
```

Hết. Không sửa logic, không đổi SDK — `POST /v1/chat/completions` nói đúng wire format
OpenAI, và chunk gốc được **phát lại nguyên văn** sau khi xác minh chứ không dựng lại,
nên `id`, `usage`, `finish_reason`, `tool_calls` đều còn nguyên.

Ba điều đáng biết:

- **Vi phạm → `finish_reason: "content_filter"`** rồi `[DONE]`, đúng quy ước OpenAI, nên SDK
  có sẵn xử lý được. Tốt hơn cắt socket giữa chừng.
- **`tool_calls` cũng bị soi.** Model hoàn toàn có thể nhét khóa vào argument của function —
  cầu dao đọc cả `function.arguments`, không chỉ `content`.
- **`stream: false` thì gom cả response kiểm một lần.** Không có mắt người đọc dần thì không
  có gì để chặn trước, nên đi đường rẻ.

Không set `UPSTREAM_KEY` thì proxy chuyển tiếp header `Authorization` của client — dùng được
cho nhiều tenant mà proxy không cần giữ khóa nào.

## Chạy thử dashboard

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
| `jev` | TypeSafe Jev, latent space, 1 call cho cả 5 tiêu chí | **308 ms** | 5/5 | 0 |
| `claude` (haiku-4-5) | LLM guardrail, strict tool use | **1 554 ms** | 5/5 | 0 |
| `claude` (opus-5) | LLM guardrail, strict tool use | **2 746 ms** | 5/5* | 0 |

`local` là fallback, không hiểu ngữ nghĩa — nó tồn tại để demo chạy offline và để hệ thống
không fail-open khi engine ngoài chết.

![so sánh engine](docs/bench.png)

Bảng trên là ảnh chụp thật của một lượt chạy (nút **⚖ So mọi engine**), 15 lượt = 3 engine × 5
kịch bản — các số trong bảng phía trên lấy từ chính lượt đó. Độ trễ engine mạng dao động vài
chục ms giữa các lần chạy; hàng `claude` (haiku-4-5) đo ở lượt riêng nên không có trong ảnh.

Điều đáng nhìn nhất: cột *Rò rỉ* xanh hết ở cả ba engine, dù p50 chênh nhau gần 100 000 lần
(0.03ms so với 2 746ms). Đó chính là luận điểm kiến trúc, và đây là số đo chứng minh nó.

### Phát hiện đáng chú ý: guardrail tự từ chối

`*` ở dòng Opus 5: trên kịch bản `harmful`, Claude trả `stop_reason: "refusal"` (category
`cyber`) — bộ phân loại an toàn của chính nó chặn cả việc **đánh giá** nội dung khai thác
zero-day. Guardrail rơi về heuristic cục bộ; ô đó đúng là nhờ fallback đỡ, không nhờ Claude.

Trong ảnh trên, dòng đó là ô cam duy nhất: cột *Đã chạy thật* ghi `claude+local` thay vì
`claude`, và bảng tổng kết ghi claude *Phải fallback: 1*.

Đây là rủi ro hệ thống khi lấy LLM đa dụng làm kiểm duyệt: **nội dung càng nguy hiểm, engine
càng dễ bỏ chạy** — đúng lúc cần nó nhất. Model phân loại chuyên dụng (Jev) và model nhỏ
(Haiku 4.5) không có hành vi này. Nếu kiến trúc của bạn dựa vào một LLM lớn làm guardrail,
đây là trường hợp phải kiểm thử trước khi lên production.

---

## Chi phí trên câu trả lời dài

Đây là chỗ một guardrail streaming sống hoặc chết, và nó không lộ ra ở demo ngắn.
Gọi evaluator lặp lại trên văn bản đang dài ra rất dễ thành chi phí bậc hai.

tokengate làm hai việc để tránh:

1. **Mỗi lượt chỉ gửi `LOOKBACK` token gần nhất + lô đang xét**, không gửi lại cả bài.
2. **Đánh giá chạy chồng với việc đọc upstream** (`PIPELINE_DEPTH`), và **lô tự to ra khi
   evaluator chậm** (`MAX_CHUNK`) — evaluator càng chậm thì số lượt gọi càng ít, chi phí
   tự co lại thay vì bùng lên.

Đo trên câu trả lời 400 token, sinh 40ms/token, baseline đo thật 19.3s:

| evaluator | | lượt gọi | ký tự gửi đi | độ trễ cộng thêm |
|---|---|---|---|---|
| Jev 300ms | ngây thơ | 50 | 56 278 (24.6x bài gốc) | +0.30s |
| Jev 300ms | **tokengate** | 50 | **6 726 (2.9x)** | **+0.11s** |
| Opus 2 700ms | ngây thơ | 50 | 56 278 (24.6x) | +116.51s |
| Opus 2 700ms | **tokengate** | **15** | **3 522 (1.5x)** | **+2.78s** |

("ngây thơ" = gửi toàn bộ ngữ cảnh, không gộp lô, không pipeline — mô phỏng bằng
`maxChunk=windowSize, lookback=Infinity, depth=1`. Bản ngây thơ thật còn chặn cả việc đọc
upstream trong lúc đánh giá, nên số thật của nó còn tệ hơn bảng này.)

Điểm cần thấy: với Jev thì cổng gần như miễn phí. Với evaluator chậm gấp 9 lần, nó vẫn
dùng được — **+2.78s thay vì +116s**. Đó là điều làm kiến trúc này chịu được engine kém.

**Đánh đổi phải biết:** cửa sổ trượt cố định nghĩa là vi phạm chỉ nhận ra khi đọc toàn bài
sẽ lọt. Tăng `LOOKBACK` nếu chính sách của bạn cần ngữ cảnh xa — đổi lại chi phí tăng.

---

## Bộ tiêu chí

Mặc định có 5 tiêu chí, cả ba engine đọc chung một khai báo:

| Mã | Tiêu chí | Hành động khi kích hoạt |
|---|---|---|
| CRIT-01 | System Prompt Exfiltration | ngắt luồng |
| CRIT-02 | Secret & Credential Leak | ngắt luồng |
| CRIT-03 | Unauthorized Legal/Pricing Commit | thay bằng cảnh báo |
| CRIT-04 | PII Disclosure | ngắt luồng |
| CRIT-05 | Harmful/Dangerous Instructions | ngắt luồng + ghi log bảo mật |

### Khai chính sách riêng

Chính sách mỗi nơi mỗi khác, nên không phải sửa source. Copy
`tokengate.config.example.json` thành `tokengate.config.json` (hoặc trỏ `TOKENGATE_CONFIG`
vào file của bạn):

```json
{
  "criteria": [
    {
      "id": "internal-docs",
      "name": "Tài liệu nội bộ chưa công bố",
      "when": "Nội dung trích dẫn lộ trình sản phẩm hoặc số liệu tài chính chưa phát hành.",
      "unless": "Nội dung chỉ dùng thông tin đã công bố công khai.",
      "threshold": 0.85,
      "action": "block",
      "patterns": [{ "re": "roadmap 2027", "flags": "i" }]
    }
  ]
}
```

| Trường | Bắt buộc | Ý nghĩa |
|---|---|---|
| `id` | có | định danh, không trùng nhau |
| `when` | có | mệnh đề engine chấm xác suất đúng/sai |
| `name` | | nhãn hiển thị, bỏ trống thì lấy `id` |
| `unless` | | mô tả trường hợp âm, giúp engine phân biệt rõ hơn |
| `threshold` | | ngưỡng kích hoạt trong (0..1], mặc định `0.8` |
| `action` | | `block` \| `replace` \| `block+log`, mặc định `block` |
| `patterns` | | regex dự phòng cho engine `local`; chuỗi, hoặc `{ re, flags, score }` |

Có file config thì bộ mặc định bị **thay hoàn toàn**, không cộng dồn.

**Config sai thì server không khởi động.** Cố tình như vậy: im lặng bỏ qua một tiêu chí
hỏng nghĩa là thủng một lỗ bảo mật mà không ai biết. Lỗi báo rõ file nào, tiêu chí thứ mấy,
thiếu gì:

```
[tokengate] không khởi động được: policy.json — tiêu chí #2 (pii): thiếu "when"
```

---

## Cấu hình

Copy `.env.example` sang `.env` rồi điền. Thiếu key nào thì engine đó tự tắt trên UI, không
fail âm thầm.

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `PORT` | `8787` | |
| `WINDOW_SIZE` | `8` | số token tối thiểu gom lại trước mỗi lượt đánh giá |
| `MAX_CHUNK` | `WINDOW_SIZE × 4` | trần token mỗi lượt; evaluator chậm → lô to hơn, gọi ít hơn |
| `LOOKBACK` | `WINDOW_SIZE × 2` | token gần nhất gửi kèm làm ngữ cảnh |
| `PIPELINE_DEPTH` | `2` | số lượt đánh giá chạy chồng nhau (commit vẫn theo thứ tự) |
| `SCB_ENGINE` | `auto` | `auto` = Jev nếu có key, không thì local |
| `TOKENGATE_CONFIG` | `tokengate.config.json` | file chính sách; không có thì dùng 5 tiêu chí mặc định |
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
| `criteria.js` | Tiêu chí mặc định + nạp và kiểm tra `tokengate.config.json` |
| `evaluator.js` | Chọn và gọi engine; mọi lỗi/timeout đều fallback cục bộ (fail-closed) |
| `claude-guard.js` | Engine Claude qua Anthropic SDK, strict tool use để ép đúng schema |
| `upstream.js` | Mock LLM 30–60ms/token + reverse proxy SSE cho endpoint thật |
| `bench.js` | Benchmark dùng chung cho CLI và `/api/bench` |
| `server.js` | SSE `/api/stream`, `/api/bench`, `/api/engines`, `/api/scenarios` + static |
| `public/` | Dashboard split-screen: stream, đồng hồ latency, đèn tiêu chí, đồ thị, bảng so sánh |
| `proxy.js` | `POST /v1/chat/completions` tương thích OpenAI; phát lại chunk gốc nguyên văn |
| `test.js` | Self-check lõi bằng `assert`, không framework |
| `test-config.js` | Test cho việc nạp chính sách: config sai phải ném, không được nuốt |
| `test-proxy.js` | Test tích hợp: dựng upstream OpenAI giả, gọi proxy qua HTTP thật |

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
- Proxy chưa có auth và rate-limit — nên đặt sau API gateway sẵn có của bạn, đừng phơi
  thẳng ra ngoài. Chuyển tiếp `Authorization` lên upstream thì có, nhưng nó không xác thực
  chính client gọi vào proxy.

## Hướng phát triển

- Bộ eval 200–500 mẫu có nhãn để biết tỉ lệ chặn nhầm thật — đây giờ là việc quan trọng nhất
  còn lại, và nó quan trọng hơn latency.
- Đặt proxy cùng region với bộ đánh giá để kiểm chứng KPI 35ms trong điều kiện hạ tầng đúng.
- Đo P50/P95/P99 trên tập tấn công thật thay vì 5 kịch bản dựng sẵn.
- Ngưỡng theo từng tiêu chí điều chỉnh được lúc chạy, kèm chế độ chỉ gắn cờ cho tiêu chí nhẹ.
