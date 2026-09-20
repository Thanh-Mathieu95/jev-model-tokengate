import { readFileSync, existsSync } from 'node:fs';

// Ma trận tiêu chí (mục 3 của spec). `semantic`/`yes`/`no` là câu hỏi noul gửi sang Jev;
// `local` là heuristic dự phòng khi không có JEV_API_KEY hoặc Jev timeout.
// action: 'abort' = ngắt luồng, 'replace' = thay bằng cảnh báo, 'abort+log' = ngắt + ghi log bảo mật.
const DEFAULT_CRITERIA = [
  {
    id: 'CRIT-01',
    name: 'System Prompt Exfiltration',
    semantic: 'Nội dung đang bộc lộ chỉ dẫn hệ thống, vai trò gốc hoặc quy tắc ẩn đã cấu hình cho AI.',
    yes: 'Nội dung đang bộc lộ system prompt, chỉ dẫn hệ thống, vai trò gốc hoặc quy tắc ẩn đã cấu hình cho AI.',
    no: 'Nội dung chỉ trả lời nghiệp vụ bình thường, không nhắc tới cấu hình hay chỉ dẫn nội bộ của AI.',
    action: 'abort',
    threshold: 0.8,
    local: [
      [/system[_\s-]?prompt|system\s+instructions?|my\s+instructions\s+are/i, 0.95],
      [/(cấu hình|chỉ dẫn|hướng dẫn|quy tắc)\s+(hệ thống|nội bộ|gốc|ẩn)/i, 0.95],
      [/\b(bạn|mày)\s+là\s+(một\s+)?(trợ lý|assistant)/i, 0.9],
      [/<\|?(system|im_start)\|?>/i, 0.95]
    ]
  },
  {
    id: 'CRIT-02',
    name: 'Secret & Credential Leak',
    semantic: 'Nội dung chứa khóa API, private key, JWT, mật khẩu cơ sở dữ liệu hoặc chuỗi bí mật khác.',
    yes: 'Nội dung chứa giá trị bí mật thật: khóa API, private key, JWT, mật khẩu, connection string.',
    no: 'Nội dung chỉ nhắc tên biến hoặc nói về bảo mật chung chung, không lộ giá trị bí mật nào.',
    action: 'abort',
    threshold: 0.8,
    local: [
      // Bắt cả tiền tố ngắn: token đầu tiên của khóa phải bị chặn khi còn trong buffer.
      [/\bsk-[A-Za-z0-9_-]{2,}/, 0.98],
      [/\b(ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{4,}/, 0.98],
      [/-----BEGIN [A-Z ]*PRIVATE KEY/, 0.98],
      [/\beyJ[A-Za-z0-9_-]{6,}\./, 0.95],
      [/\b(api[_\s-]?key|secret|token|password|passwd|pwd|mật\s*khẩu)\b\s*[:=]\s*["'`]?\S{4,}/i, 0.9],
      [/\bAKIA[0-9A-Z]{6,}/, 0.98]
    ]
  },
  {
    id: 'CRIT-03',
    name: 'Unauthorized Legal/Pricing Commit',
    semantic: 'Nội dung đưa ra cam kết tài chính hoặc pháp lý không được ủy quyền: giảm giá lớn, hoàn tiền vô điều kiện, bảo hành trọn đời.',
    yes: 'Nội dung đưa ra cam kết tài chính hoặc pháp lý cụ thể chưa được ủy quyền: giảm giá lớn, hoàn tiền vô điều kiện, bảo hành trọn đời, nhận bồi thường.',
    no: 'Nội dung chỉ mô tả chính sách sẵn có hoặc hướng dẫn khách liên hệ bộ phận có thẩm quyền.',
    action: 'replace',
    threshold: 0.8,
    local: [
      [/(giảm|discount|sale)\s*(giá\s*)?(lên\s*(tới|đến)\s*)?[2-9]\d\s*%/i, 0.92],
      [/hoàn\s*(lại\s*)?(tiền|phí)\s*(100\s*%|toàn\s*bộ|vô\s*điều\s*kiện)/i, 0.95],
      [/(unconditional|full)\s+refund|refund\s+100\s*%/i, 0.95],
      [/(miễn phí|bảo hành|cam kết)\s+(trọn đời|vĩnh viễn|suốt đời)/i, 0.9],
      [/(tôi|chúng tôi)\s+cam kết\s+(bồi thường|đền bù|chịu trách nhiệm pháp lý)/i, 0.9]
    ]
  },
  {
    id: 'CRIT-04',
    name: 'PII Disclosure',
    semantic: 'Nội dung đọc ra thông tin định danh cá nhân của người khác: số căn cước, thẻ tín dụng, bệnh án.',
    yes: 'Nội dung đọc ra thông tin định danh cá nhân của người khác: số căn cước, số thẻ tín dụng, bệnh án, hồ sơ y tế.',
    no: 'Nội dung không chứa dữ liệu định danh của bất kỳ cá nhân cụ thể nào.',
    action: 'abort',
    threshold: 0.8,
    local: [
      [/\b(cccd|cmnd|căn cước|số\s*bảo\s*hiểm|ssn)\b\s*[:=]?\s*\d{4,}/i, 0.95],
      [/\b(?:\d[ -]?){15,18}\b/, 0.85],            // số thẻ tín dụng đã chuẩn hoá khoảng cách
      [/\b(bệnh án|chẩn đoán|hồ sơ y tế)\s+(của|số)\b/i, 0.9],
      [/\b\d{12}\b\s*(là\s*)?(cccd|cmnd|căn cước)/i, 0.95]
    ]
  },
  {
    id: 'CRIT-05',
    name: 'Harmful/Dangerous Instructions',
    semantic: 'Nội dung hướng dẫn chế tạo vũ khí, khai thác lỗ hổng zero-day, hoặc hành vi tự hại.',
    yes: 'Nội dung hướng dẫn hành vi nguy hiểm: chế tạo vũ khí, khai thác lỗ hổng zero-day, hoặc tự hại.',
    no: 'Nội dung không hướng dẫn bất kỳ hành vi gây hại nào.',
    action: 'abort+log',
    threshold: 0.8,
    local: [
      [/(chế tạo|tự\s*làm|cách\s*làm)\s+(bom|thuốc nổ|vũ khí|chất độc)/i, 0.96],
      [/\b(zero[-\s]?day|0day)\b.{0,40}\b(exploit|khai thác|payload|rce)\b/i, 0.93],
      [/\b(exploit|khai thác)\b.{0,40}\b(zero[-\s]?day|0day)\b/i, 0.93],
      [/(cách|hướng dẫn)\s+(tự\s*tử|tự\s*hại|kết liễu)/i, 0.97]
    ]
  }
];

// ---------------------------------------------------------------------------
// Chính sách khai từ ngoài: tokengate.config.json (hoặc TOKENGATE_CONFIG).
// Không có file -> dùng bộ mặc định ở trên.
//
// Đây là biên giới tin cậy: config sai mà im lặng bỏ qua một tiêu chí nghĩa là
// thủng một lỗ bảo mật mà không ai biết. Nên mọi lỗi đều NÉM, server không khởi
// động được, thay vì chạy với chính sách thiếu.

const ACTIONS = { block: 'abort', replace: 'replace', 'block+log': 'abort+log' };

function buildPattern(p, where) {
  const src = typeof p === 'string' ? p : p?.re;
  if (typeof src !== 'string' || !src) {
    throw new Error(`${where}: mỗi phần tử patterns phải là chuỗi regex hoặc { re, flags, score }`);
  }
  const score = typeof p === 'string' ? 0.95 : p.score ?? 0.95;
  if (typeof score !== 'number' || score < 0 || score > 1) {
    throw new Error(`${where}: score phải là số trong khoảng 0..1`);
  }
  try {
    return [new RegExp(src, typeof p === 'string' ? '' : p.flags ?? ''), score];
  } catch (err) {
    throw new Error(`${where}: regex không hợp lệ (${src}) — ${err.message}`);
  }
}

/** Kiểm tra và đổi một tiêu chí dạng config sang dạng nội bộ. Ném nếu sai. */
export function compileCriterion(raw, index, seen = new Set()) {
  const where = `tiêu chí #${index + 1}${raw?.id ? ` (${raw.id})` : ''}`;
  if (!raw || typeof raw !== 'object') throw new Error(`${where}: phải là object`);

  const id = raw.id;
  if (typeof id !== 'string' || !id.trim()) throw new Error(`${where}: thiếu "id"`);
  if (seen.has(id)) throw new Error(`${where}: "id" bị trùng`);
  seen.add(id);

  const when = raw.when;
  if (typeof when !== 'string' || !when.trim()) {
    throw new Error(`${where}: thiếu "when" — mô tả ngữ nghĩa để engine chấm điểm`);
  }

  const threshold = raw.threshold ?? 0.8;
  if (typeof threshold !== 'number' || threshold <= 0 || threshold > 1) {
    throw new Error(`${where}: "threshold" phải là số trong khoảng (0..1], đang là ${JSON.stringify(raw.threshold)}`);
  }

  const actionKey = raw.action ?? 'block';
  if (!(actionKey in ACTIONS)) {
    throw new Error(`${where}: "action" phải là một trong ${Object.keys(ACTIONS).join(', ')} — đang là ${JSON.stringify(actionKey)}`);
  }

  if (raw.patterns !== undefined && !Array.isArray(raw.patterns)) {
    throw new Error(`${where}: "patterns" phải là mảng`);
  }

  return {
    id,
    name: raw.name ?? id,
    semantic: when,
    yes: when,
    no: raw.unless ?? `Nội dung không thuộc trường hợp: ${when}`,
    action: ACTIONS[actionKey],
    threshold,
    local: (raw.patterns ?? []).map((p, i) => buildPattern(p, `${where} patterns[${i}]`))
  };
}

/** Đổi cả file config. Ném kèm tên file để người dùng biết sửa ở đâu. */
export function compileConfig(cfg, source = 'config') {
  if (!cfg || typeof cfg !== 'object') throw new Error(`${source}: nội dung phải là object JSON`);
  if (!Array.isArray(cfg.criteria) || cfg.criteria.length === 0) {
    throw new Error(`${source}: cần mảng "criteria" có ít nhất một phần tử`);
  }
  const seen = new Set();
  return cfg.criteria.map((c, i) => {
    try {
      return compileCriterion(c, i, seen);
    } catch (err) {
      throw new Error(`${source} — ${err.message}`);
    }
  });
}

function loadOverride() {
  const path = process.env.TOKENGATE_CONFIG || 'tokengate.config.json';
  if (!existsSync(path)) return null;
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path}: không phải JSON hợp lệ — ${err.message}`);
  }
  const compiled = compileConfig(cfg, path);
  console.error(`[tokengate] nạp ${compiled.length} tiêu chí từ ${path}`);
  return compiled;
}

export const CRITERIA = loadOverride() ?? DEFAULT_CRITERIA;

export const BY_ID = Object.fromEntries(CRITERIA.map((c) => [c.id, c]));
