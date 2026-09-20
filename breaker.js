// Core: Sliding Buffer + Stream Switch Controller (mục 2.1).

export const BLOCK_PAYLOAD = { status: 'blocked', reason: 'policy_violation' };

// Item của source: chuỗi thuần (demo), hoặc { text, raw } khi proxy cần giữ
// nguyên chunk gốc để phát lại đúng từng byte sau khi đã xác minh.
const textOf = (item) => (typeof item === 'string' ? item : item?.text ?? '');
const REPLACEMENT = '[Nội dung đã được thay thế: phản hồi chứa cam kết chưa được ủy quyền.]';

export function percentile(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)].toFixed(2);
}

/**
 * Kiến trúc B — tiền kiểm inline.
 * Token nằm ở trạng thái Pending Verification; chỉ được phát hành sau khi lô
 * hiện tại All Pass. Vi phạm -> drop buffer, abort cả 2 đầu.
 *
 * Hai tính chất quyết định chi phí, đừng bỏ khi sửa về sau:
 *
 *  1. Đọc upstream chạy song song với đánh giá (producer riêng). Sinh 8 token mất
 *     ~320ms, đánh giá mất ~300ms -> độ trễ đánh giá nấp sau tốc độ sinh token
 *     thay vì cộng dồn. Chờ kết quả rồi mới đọc tiếp là cộng dồn: 800 token = +30s.
 *  2. Mỗi lượt chỉ gửi `lookback` token gần nhất + lô đang xét, KHÔNG gửi cả bài.
 *     Gửi cả bài là chi phí bậc hai: 800 token -> 58.000 token input.
 *
 * @param source     async iterable các token từ LLM upstream
 * @param evaluate   (text) => { results, tripped, latencyMs }
 * @param emit       (event) => void — sự kiện gửi xuống client
 * @param windowSize số token tối thiểu gom lại trước mỗi lượt đánh giá
 * @param maxChunk   trần số token mỗi lượt; evaluator càng chậm lô càng to, số
 *                   lượt gọi càng ít -> chi phí tự co lại thay vì bùng lên
 * @param lookback   số token gần nhất gửi kèm làm ngữ cảnh
 * @param depth      số lượt đánh giá được phép chạy chồng nhau (commit vẫn theo thứ tự)
 * @param abortUpstream () => void — hủy sinh token để tiết kiệm chi phí
 */
export async function runCircuitBreaker({
  source, evaluate, emit, abortUpstream,
  windowSize = 8,
  maxChunk = windowSize * 4,
  lookback = windowSize * 2,
  depth = 2
}) {
  const latencies = [];
  let released = '';
  let evalCount = 0;

  // ponytail: cửa sổ trượt cố định. Vi phạm chỉ nhận ra khi đọc toàn bài sẽ lọt
  // qua — nâng `lookback`, hoặc chuyển sang evaluator có trạng thái (gửi delta,
  // server giữ ngữ cảnh) nếu cần ngữ cảnh xa.
  const recent = [];

  const pending = [];
  let srcDone = false;
  let srcError = null;
  let stop = false;
  let wake = null;
  const ping = () => { const w = wake; wake = null; w?.(); };
  const more = () => new Promise((r) => { wake = r; });

  // Producer: hút token về liên tục, không chờ kết quả đánh giá.
  (async () => {
    try {
      for await (const token of source) {
        if (stop) break;
        pending.push(token);
        ping();
      }
    } catch (err) {
      srcError = err;
    } finally {
      srcDone = true;
      ping();
    }
  })();

  // Pipeline: cho phép `depth` lượt đánh giá chạy chồng nhau, nhưng COMMIT THEO
  // THỨ TỰ. Nhờ vậy độ trễ đánh giá nấp sau tốc độ sinh token thay vì nối đuôi.
  // Nối đuôi: mỗi chu kỳ = thời gian sinh 1 lô + thời gian đánh giá 1 lô.
  // Chồng nhau : mỗi chu kỳ = max(hai thứ đó). Token vẫn chỉ phát hành sau khi
  // lô của nó VÀ mọi lô trước nó đều All Pass, nên bảo đảm 0 rò rỉ không đổi.
  const inflight = [];

  const dispatch = () => {
    const chunk = pending.splice(0, Math.min(pending.length, maxChunk));
    const text = chunk.map(textOf).join('');
    const input = recent.join('') + text;
    // Ngữ cảnh chạy theo lô đã GỬI ĐI, không theo lô đã phát hành — lô trước tuy
    // chưa xác minh vẫn là ngữ cảnh đúng để chấm lô sau; trượt thì bỏ cả cụm.
    recent.push(...chunk.map(textOf));
    if (recent.length > lookback) recent.splice(0, recent.length - lookback);
    inflight.push({ text, chunk, promise: evaluate(input) });
  };

  let tripped = null;
  while (true) {
    while (inflight.length < depth && (pending.length >= windowSize || (srcDone && pending.length))) {
      dispatch();
    }
    if (!inflight.length) {
      if (srcDone && !pending.length) break;
      await more();
      continue;
    }

    const { text, chunk, promise } = inflight.shift();
    const v = await promise;
    evalCount++;
    latencies.push(v.latencyMs);
    emit({ type: 'eval', latencyMs: v.latencyMs, engine: v.engine, results: v.results });

    if (v.tripped) { tripped = v.tripped; break; } // lô này chưa bao giờ rời proxy

    released += text;
    emit({ type: 'token', text, chunk }); // `chunk` = item gốc, proxy phát lại nguyên văn
  }

  stop = true;

  if (tripped) {
    pending.length = 0;
    inflight.length = 0; // lô đang bay cũng bị bỏ, không phát hành
    abortUpstream?.();
    if (tripped.action === 'replace') {
      emit({ type: 'replaced', criterion: tripped, text: REPLACEMENT });
    } else {
      emit({ type: 'blocked', criterion: tripped, payload: BLOCK_PAYLOAD });
    }
    if (tripped.action === 'abort+log') {
      emit({ type: 'security_log', criterion: tripped, at: new Date().toISOString() });
    }
  } else if (srcError) {
    throw srcError;
  }

  const stats = {
    arch: 'scb',
    tripped: tripped?.id ?? null,
    evalCount,
    leakedChars: 0,
    releasedChars: released.length,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99)
  };
  emit({ type: 'done', stats });
  return { released, stats };
}

/**
 * Kiến trúc A — LLM Guardrail hậu kiểm, dựng lại để đo đối đầu.
 * Token phát ra ngay; kiểm duyệt chạy trễ `guardrailDelayMs` rồi mới ra lệnh xóa.
 * Mọi ký tự vi phạm hiển thị trong khoảng trễ đó là leak đã xảy ra.
 */
export async function runTraditionalGuardrail({
  source, evaluate, emit, windowSize = 8, guardrailDelayMs = 1200, probe = evaluate
}) {
  const latencies = [];
  let released = '';
  let sinceCheck = 0;
  let evalCount = 0;
  let verdict = null;      // kết quả kiểm duyệt trả về muộn
  let leakStart = null;    // độ dài chuỗi tại thời điểm vi phạm thực sự lên màn hình
  const pending = [];

  const schedule = (snapshot) => {
    pending.push((async () => {
      await new Promise((r) => setTimeout(r, guardrailDelayMs));
      const v = await evaluate(snapshot);
      evalCount++;
      latencies.push(v.latencyMs + guardrailDelayMs);
      emit({ type: 'eval', latencyMs: +(v.latencyMs + guardrailDelayMs).toFixed(2), engine: 'llm-guardrail', results: v.results });
      if (v.tripped && !verdict) verdict = v.tripped;
    })());
  };

  for await (const item of source) {
    const token = textOf(item);
    released += token;
    emit({ type: 'token', text: token });
    if (leakStart === null) {
      // Chỉ để đo mốc rò rỉ, không tác động luồng -> dùng bộ dò rẻ, đừng đốt quota engine ngoài.
      const p = await probe(released);
      if (p.tripped) leakStart = released.length;
    }
    if (++sinceCheck >= windowSize) { sinceCheck = 0; schedule(released); }
    if (verdict) break; // lệnh xóa vừa về -> mới dừng được, muộn mất rồi
  }

  if (!verdict) { schedule(released); await Promise.all(pending); }

  if (verdict) {
    emit({ type: 'redact', criterion: verdict, text: 'Nội dung đã bị xóa' });
  }

  const stats = {
    arch: 'traditional',
    tripped: verdict?.id ?? null,
    evalCount,
    leakedChars: leakStart === null ? 0 : released.length - leakStart,
    releasedChars: released.length,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99)
  };
  emit({ type: 'done', stats });
  return { released, stats };
}
