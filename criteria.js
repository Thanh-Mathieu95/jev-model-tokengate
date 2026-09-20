// Ma trận tiêu chí (mục 3 của spec). `semantic`/`yes`/`no` là câu hỏi noul gửi sang Jev;
// `local` là heuristic dự phòng khi không có JEV_API_KEY hoặc Jev timeout.
// action: 'abort' = ngắt luồng, 'replace' = thay bằng cảnh báo, 'abort+log' = ngắt + ghi log bảo mật.
export const CRITERIA = [
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

export const BY_ID = Object.fromEntries(CRITERIA.map((c) => [c.id, c]));
