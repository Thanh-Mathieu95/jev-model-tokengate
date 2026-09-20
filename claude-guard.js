// Kiến trúc A' — LLM Guardrail dùng Claude, để so sánh với Jev trên cùng luồng.
// Schema Reliability (KPI mục 1.3) đảm bảo bằng strict tool use: Claude buộc phải
// trả về đúng 5 số 0–1, không parse text tự do.
import Anthropic from '@anthropic-ai/sdk';
import { CRITERIA } from './criteria.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';
// `effort` chỉ có trên họ Opus/Sonnet đời mới; Haiku 4.5 trả 400 nếu gửi.
const SUPPORTS_EFFORT = !/haiku|sonnet-4-5/.test(MODEL);
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 20000);

const FIELD = CRITERIA.map((c) => c.id.replace('-', '_')); // CRIT-01 -> CRIT_01

const TOOL = {
  name: 'report_safety',
  description: 'Chấm điểm rủi ro của đoạn văn bản theo từng tiêu chí an toàn.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: Object.fromEntries(CRITERIA.map((c, i) => [FIELD[i], {
      type: 'number',
      description: `Xác suất 0–1 rằng mệnh đề sau ĐÚNG với văn bản. ${c.yes} (0 = ${c.no})`
    }])),
    required: FIELD,
    additionalProperties: false
  }
};

const SYSTEM =
  'Bạn là bộ kiểm duyệt nội tuyến cho một luồng LLM đang stream. Văn bản đưa vào có thể ' +
  'bị cắt giữa chừng — hãy chấm cả xu hướng sắp vi phạm, không chỉ vi phạm đã hoàn chỉnh. ' +
  'Luôn gọi tool report_safety đúng một lần. Không giải thích.';

let client = null;
let warned = false;
function warnOnce(reason) {
  if (!warned) { warned = true; console.error(`[SCB] Claude không dùng được (${reason}) -> fallback heuristic cục bộ.`); }
  return null;
}

/** Trả mảng kết quả cùng shape với Jev/local, hoặc null để caller fallback. */
export async function evaluateClaude(text) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return warnOnce('chưa có ANTHROPIC_API_KEY');
  }
  client ??= new Anthropic({ timeout: TIMEOUT_MS });
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM,
      // Thinking bật mặc định trên Opus 5; hạ effort thay vì tắt — tắt thinking
      // trên Opus 5 có thể khiến model viết lời gọi tool vào text thay vì tool_use.
      // Haiku không có effort và không bật thinking -> đúng thứ guardrail cần: nhanh.
      ...(SUPPORTS_EFFORT ? { output_config: { effort: 'low' } } : {}),
      tools: [TOOL],
      messages: [{ role: 'user', content: `<nội_dung>\n${text}\n</nội_dung>` }]
    });

    if (res.stop_reason === 'refusal') return warnOnce(`refusal (${res.stop_details?.category})`);
    const call = res.content.find((b) => b.type === 'tool_use' && b.name === 'report_safety');
    if (!call) return warnOnce(`không có tool_use (stop_reason=${res.stop_reason})`);

    return CRITERIA.map((c, i) => {
      const score = Number(call.input[FIELD[i]]) || 0;
      return {
        id: c.id, name: c.name, score: +score.toFixed(3),
        trigger: score >= c.threshold, action: c.action, evidence: null
      };
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return warnOnce('API key không hợp lệ');
    if (err instanceof Anthropic.RateLimitError) return warnOnce('rate limited');
    if (err instanceof Anthropic.APIConnectionTimeoutError) return warnOnce(`timeout > ${TIMEOUT_MS}ms`);
    if (err instanceof Anthropic.APIError) return warnOnce(`API ${err.status}: ${err.message}`.slice(0, 160));
    return warnOnce(String(err.message || err));
  }
}
