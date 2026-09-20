// Core: Sliding Buffer + Stream Switch Controller (mục 2.1).

export const BLOCK_PAYLOAD = { status: 'blocked', reason: 'policy_violation' };
const REPLACEMENT = '[Nội dung đã được thay thế: phản hồi chứa cam kết chưa được ủy quyền.]';

export function percentile(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)].toFixed(2);
}

/**
 * Kiến trúc B — tiền kiểm inline.
 * Token nằm trong buffer ở trạng thái Pending Verification; chỉ được phát hành
 * sau khi cửa sổ hiện tại All Pass. Vi phạm -> drop buffer, abort cả 2 đầu.
 *
 * @param source    async iterable các token từ LLM upstream
 * @param evaluate  (text) => { results, tripped, latencyMs }
 * @param emit      (event) => void  — sự kiện gửi xuống client
 * @param windowSize số token đệm trước mỗi lượt đánh giá
 * @param abortUpstream () => void — hủy sinh token để tiết kiệm chi phí
 */
export async function runCircuitBreaker({ source, evaluate, emit, windowSize = 8, abortUpstream }) {
  const buffer = [];
  const latencies = [];
  let released = '';
  let evalCount = 0;

  const flush = () => {
    if (!buffer.length) return;
    const text = buffer.splice(0).join('');
    released += text;
    emit({ type: 'token', text });
  };

  const check = async () => {
    const v = await evaluate(released + buffer.join(''));
    evalCount++;
    latencies.push(v.latencyMs);
    emit({ type: 'eval', latencyMs: v.latencyMs, engine: v.engine, results: v.results });
    return v;
  };

  const trip = (t) => {
    buffer.length = 0; // token pending không bao giờ rời proxy
    abortUpstream?.();
    if (t.action === 'replace') {
      emit({ type: 'replaced', criterion: t, text: REPLACEMENT });
    } else {
      emit({ type: 'blocked', criterion: t, payload: BLOCK_PAYLOAD });
    }
    if (t.action === 'abort+log') emit({ type: 'security_log', criterion: t, at: new Date().toISOString() });
  };

  let tripped = null;
  for await (const token of source) {
    buffer.push(token);
    if (buffer.length < windowSize) continue;
    const v = await check();
    if (v.tripped) { tripped = v.tripped; break; }
    flush();
  }

  if (!tripped && buffer.length) {
    const v = await check(); // đuôi luồng vẫn phải qua cầu dao
    if (v.tripped) tripped = v.tripped;
    else flush();
  }

  if (tripped) trip(tripped);

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
  source, evaluate, emit, windowSize = 8, guardrailDelayMs = 1200
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

  for await (const token of source) {
    released += token;
    emit({ type: 'token', text: token });
    if (leakStart === null) {
      const probe = await evaluate(released); // chỉ để đo, không tác động luồng
      if (probe.tripped) leakStart = released.length;
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
