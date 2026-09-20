import { CRITERIA, BY_ID } from './criteria.js';
import { evaluateClaude } from './claude-guard.js';

const JEV_URL = process.env.JEV_URL || 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = process.env.JEV_MODEL || 'jev-latest';
// Fail-Safe (mục 7). Spec đặt 80ms với giả định Jev cùng region/edge node.
// Gọi qua internet công cộng thì RTT một mình đã vượt ngưỡng đó -> mặc định nới rộng.
const JEV_TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS || 1500);

// Jev nhận dict `questions`; key phải ổn định để map ngược về mã tiêu chí.
const QKEY = Object.fromEntries(CRITERIA.map((c, i) => [`q${i}`, c.id]));
const QUESTIONS = Object.fromEntries(CRITERIA.map((c, i) => [`q${i}`, {
  type: 'noul',
  instructions: c.semantic,
  criteria: { true: c.yes, false: c.no }
}]));

/** Heuristic cục bộ: chạy song song toàn bộ ma trận tiêu chí trên cùng một chuỗi. */
function evaluateLocal(text) {
  return CRITERIA.map((c) => {
    let score = 0;
    let hit = null;
    for (const [re, s] of c.local) {
      const m = re.exec(text);
      if (m && s > score) { score = s; hit = m[0].slice(0, 40); }
    }
    return { id: c.id, name: c.name, score, trigger: score >= c.threshold, action: c.action, evidence: hit };
  });
}

/**
 * POST /v1/systemone — đánh giá song song cả 5 tiêu chí trong MỘT lượt gọi.
 * Trả null nếu thiếu key, lỗi, hoặc quá JEV_TIMEOUT_MS -> caller rơi về
 * heuristic cục bộ thay vì mở cửa luồng.
 */
let warned = false;
/** Báo một lần rồi thôi — fallback im lặng là cách hay nhất để không biết mình đang chạy regex. */
function warnOnce(reason) {
  if (!warned) { warned = true; console.error(`[SCB] Jev không dùng được (${reason}) -> fallback heuristic cục bộ.`); }
  return null;
}

async function evaluateJev(text) {
  const key = process.env.JEV_API_KEY;
  if (!key) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), JEV_TIMEOUT_MS);
  try {
    const r = await fetch(JEV_URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ state: text, model: JEV_MODEL, questions: QUESTIONS })
    });
    if (!r.ok) return warnOnce(`HTTP ${r.status} ${await r.text().catch(() => '')}`.slice(0, 200));
    const body = await r.json();
    const answers = body.answers;
    if (!answers || typeof answers !== 'object') {
      return warnOnce(`phản hồi không có answers: ${JSON.stringify(body).slice(0, 200)}`);
    }
    // noul = xác suất câu khẳng định đúng (0..1) -> dùng trực tiếp làm score.
    return CRITERIA.map((c, i) => {
      const score = answers[`q${i}`]?.noul ?? 0;
      return {
        id: c.id,
        name: c.name,
        score: +score.toFixed(3),
        trigger: score >= c.threshold,
        action: c.action,
        evidence: null
      };
    });
  } catch (err) {
    warnOnce(err.name === 'AbortError' ? `timeout > ${JEV_TIMEOUT_MS}ms` : String(err.message || err));
    return null; // timeout / mạng lỗi -> heuristic cục bộ
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Một lượt đánh giá ma trận trên MỘT engine.
 * engine: 'jev' | 'claude' | 'local' | 'auto' (auto = jev nếu có key, không thì local).
 * Mọi engine trả cùng shape; engine ngoài trả null -> rơi về heuristic cục bộ.
 */
export async function evaluate(text, engine = process.env.SCB_ENGINE || 'auto') {
  const t0 = performance.now();
  let results = null;
  if (engine === 'claude') results = await evaluateClaude(text);
  else if (engine === 'jev' || (engine === 'auto' && process.env.JEV_API_KEY)) results = await evaluateJev(text);
  const used = results ? engine === 'auto' ? 'jev' : engine : 'local';
  results ??= evaluateLocal(text);
  const latencyMs = +(performance.now() - t0).toFixed(2);
  const tripped = results.find((r) => r.trigger) || null;
  // engine = cái thực sự đã chạy, không phải cái được cấu hình.
  return { results, tripped, latencyMs, engine: used };
}

export { evaluateLocal };
