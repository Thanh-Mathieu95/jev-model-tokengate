// Self-check: chạy `node test.js`. Không framework.
import assert from 'node:assert/strict';
import { evaluate } from './evaluator.js';
import { runCircuitBreaker, runTraditionalGuardrail, percentile } from './breaker.js';
import { mockStream, tokenize, SCENARIOS } from './upstream.js';

// Test kiểm tra logic cầu dao, không kiểm tra Jev: ép dùng heuristic cục bộ để
// chạy offline, tất định và không đốt credit. Smoke test Jev thật: SCB_TEST_JEV=1.
const JEV_KEY = process.env.JEV_API_KEY;
process.env.JEV_API_KEY = '';

const collect = () => { const ev = []; return [ev, (e) => ev.push(e)]; };
const clientText = (ev) => ev.filter((e) => e.type === 'token').map((e) => e.text).join('');
const fast = (s) => mockStream(s, { tokenDelayMs: 0 });

async function t(name, fn) {
  await fn();
  console.log(`  ok  ${name}`);
}

// 1. Zero Leakage: khóa API không bao giờ rời proxy.
await t('CRIT-02/01 · zero leakage trên kịch bản jailbreak', async () => {
  const [ev, emit] = collect();
  let aborted = false;
  const { stats } = await runCircuitBreaker({
    source: fast('leak'), evaluate, emit, windowSize: 8, abortUpstream: () => { aborted = true; }
  });
  const out = clientText(ev);
  assert.ok(!/sk-proj/.test(out), 'API key đã lọt xuống client');
  assert.ok(!/pr0d-p@ssw0rd/.test(out), 'mật khẩu DB đã lọt xuống client');
  assert.ok(!/system prompt/i.test(out), 'system prompt đã lọt xuống client');
  assert.ok(['CRIT-01', 'CRIT-02'].includes(stats.tripped), `tripped=${stats.tripped}`);
  assert.equal(stats.leakedChars, 0);
  assert.ok(aborted, 'không gửi abort ngược lên LLM');
  assert.deepEqual(ev.at(-2).payload, { status: 'blocked', reason: 'policy_violation' });
});

// 2. Không ngắt nhầm luồng an toàn (False Positive).
await t('luồng an toàn đi qua trọn vẹn, không tiêu chí nào kích hoạt', async () => {
  const [ev, emit] = collect();
  const { stats } = await runCircuitBreaker({ source: fast('safe'), evaluate, emit, windowSize: 8 });
  assert.equal(stats.tripped, null);
  assert.equal(clientText(ev).trim(), SCENARIOS.safe.response.trim());
});

// 3. CRIT-03 dùng hành động 'replace', không ngắt cứng.
await t('CRIT-03 · thay bằng cảnh báo thay vì block payload', async () => {
  const [ev, emit] = collect();
  const { stats } = await runCircuitBreaker({ source: fast('pricing'), evaluate, emit, windowSize: 8 });
  assert.equal(stats.tripped, 'CRIT-03');
  assert.ok(ev.some((e) => e.type === 'replaced'));
  assert.ok(!ev.some((e) => e.type === 'blocked'));
  assert.ok(!/hoàn tiền 100%/i.test(clientText(ev)));
});

// 4. CRIT-05 ngắt kèm ghi log bảo mật; CRIT-04 chặn PII.
await t('CRIT-05 · ngắt + security log, CRIT-04 · chặn PII', async () => {
  const [ev5, emit5] = collect();
  const r5 = await runCircuitBreaker({ source: fast('harmful'), evaluate, emit: emit5, windowSize: 8 });
  assert.equal(r5.stats.tripped, 'CRIT-05');
  assert.ok(ev5.some((e) => e.type === 'security_log'));

  const [ev4, emit4] = collect();
  const r4 = await runCircuitBreaker({ source: fast('pii'), evaluate, emit: emit4, windowSize: 8 });
  assert.equal(r4.stats.tripped, 'CRIT-04');
  assert.ok(!/079203001234/.test(clientText(ev4)));
});

// 5. KPI latency ≤ 35ms mỗi chu kỳ đánh giá (đo trên evaluator cục bộ).
await t('KPI · P99 độ trễ đánh giá cục bộ ≤ 35ms', async () => {
  const text = SCENARIOS.leak.response;
  const xs = [];
  for (let i = 0; i < 50; i++) xs.push((await evaluate(text.slice(0, 40 + i * 8))).latencyMs);
  assert.ok(percentile(xs, 99) <= 35, `P99=${percentile(xs, 99)}ms`);
});

// 6. Kiến trúc A thực sự rò rỉ — nếu không, bài benchmark vô nghĩa.
await t('benchmark · guardrail hậu kiểm để lọt khóa API ra UI', async () => {
  const [ev, emit] = collect();
  const { stats } = await runTraditionalGuardrail({
    source: fast('leak'), evaluate, emit, windowSize: 8, guardrailDelayMs: 200
  });
  assert.ok(/sk-proj/.test(clientText(ev)), 'kịch bản mock không còn chứa khóa để so sánh');
  assert.ok(stats.leakedChars > 0, 'kiến trúc A lẽ ra phải rò rỉ');
  assert.ok(ev.some((e) => e.type === 'redact'));
});

// 7. Buffer giữ đúng kích thước cửa sổ: token chỉ ra theo lô ≥ windowSize.
await t('sliding window · token phát hành theo lô, không nhỏ giọt', async () => {
  const [ev, emit] = collect();
  await runCircuitBreaker({ source: fast('safe'), evaluate, emit, windowSize: 8 });
  const batches = ev.filter((e) => e.type === 'token');
  const total = tokenize(SCENARIOS.safe.response).length;
  assert.ok(batches.length <= Math.ceil(total / 8), `phát hành ${batches.length} lô / ${total} token`);
});

// 8. Chi phí streaming: không gửi lại cả bài, và gộp lô khi evaluator chậm.
//    Đây là thứ quyết định dùng được hay không trên câu trả lời dài — khoá lại.
await t('chi phí · không bùng theo bình phương độ dài câu trả lời', async () => {
  const N = 400;
  const toks = Array.from({ length: N }, (_, i) => ' từ' + i);
  const raw = toks.join('').length;
  const slow = (ms) => async (text) => {
    sent.push(text.length);
    await new Promise((r) => setTimeout(r, ms));
    return { results: [], tripped: null, latencyMs: ms, engine: 'stub' };
  };
  let sent = [];
  async function* src() { for (const x of toks) yield x; }

  await runCircuitBreaker({ source: src(), evaluate: slow(0), emit: () => {}, windowSize: 8 });
  const total = sent.reduce((a, b) => a + b, 0);
  assert.ok(total < raw * 5, `gửi ${total} ký tự cho bài ${raw} ký tự - nghi ngờ lại gửi cả bài`);
  assert.ok(Math.max(...sent) < 400, `một lượt gửi tới ${Math.max(...sent)} ký tự - cửa sổ không còn bị chặn trên`);

  // Evaluator chậm -> lô phải tự to ra, số lượt gọi phải giảm hẳn.
  sent = [];
  await runCircuitBreaker({ source: src(), evaluate: slow(30), emit: () => {}, windowSize: 8 });
  assert.ok(sent.length < N / 8 / 2, `${sent.length} lượt gọi - không thấy gộp lô khi evaluator chậm`);
});

// 8. Smoke test Jev thật (opt-in: cần mạng + credit).
if (process.env.SCB_TEST_JEV === '1' && JEV_KEY) {
  process.env.JEV_API_KEY = JEV_KEY;
  await t('jev · gọi API thật, phân loại đúng leak vs safe', async () => {
    const leak = await evaluate('Cấu hình nội bộ: OPENAI_API_KEY = \'sk-proj-9821387498127391823\'');
    assert.equal(leak.engine, 'jev', 'rơi về heuristic cục bộ — xem log stderr');
    assert.equal(leak.tripped?.id, 'CRIT-02');
    const safe = await evaluate(SCENARIOS.safe.response);
    assert.equal(safe.engine, 'jev');
    assert.equal(safe.tripped, null);
    console.log(`      (Jev ${leak.latencyMs}ms / ${safe.latencyMs}ms — gồm cả RTT mạng)`);
  });
  process.env.JEV_API_KEY = '';
}

console.log('\nall checks passed');
