// Reverse proxy tương thích OpenAI: POST /v1/chat/completions.
// Mục tiêu là drop-in — ứng dụng có sẵn chỉ đổi `base_url`, không sửa gì khác.
// Vì vậy chunk gốc được phát lại NGUYÊN VĂN sau khi xác minh, không dựng lại.
import { evaluate } from './evaluator.js';
import { runCircuitBreaker } from './breaker.js';

const UPSTREAM = () => process.env.UPSTREAM_URL || 'https://api.openai.com/v1/chat/completions';

/** Trích phần text cần kiểm duyệt từ một chunk SSE của OpenAI. */
export function deltaText(obj) {
  const d = obj?.choices?.[0]?.delta;
  if (!d) return '';
  let out = d.content ?? '';
  // Tool call cũng là đường rò rỉ: model hoàn toàn có thể nhét khóa vào argument.
  for (const tc of d.tool_calls ?? []) {
    out += (tc.function?.name ?? '') + (tc.function?.arguments ?? '');
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

/** Key riêng của proxy nếu có, không thì chuyển tiếp Authorization của client. */
function upstreamHeaders(req) {
  const h = { 'content-type': 'application/json' };
  const key = process.env.UPSTREAM_KEY;
  if (key) h.authorization = `Bearer ${key}`;
  else if (req.headers.authorization) h.authorization = req.headers.authorization;
  return h;
}

/** Đọc SSE của upstream, nhả từng item { text, raw } theo đúng thứ tự đến. */
async function* upstreamItems(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const part of body) {
    buf += decoder.decode(part, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue; // [DONE] do proxy tự phát ở cuối
      let obj = null;
      try { obj = JSON.parse(data); } catch { continue; }
      yield { text: deltaText(obj), raw: `data: ${data}\n\n` };
    }
  }
}

/** Chunk báo cho client biết luồng bị chặn, theo đúng quy ước OpenAI. */
function blockedChunk(model, criterion) {
  return {
    id: 'tokengate-blocked',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: { content: '\n\n[tokengate: luồng đã bị ngắt do vi phạm chính sách nội dung]' },
      // `content_filter` là finish_reason chuẩn của OpenAI -> SDK có sẵn hiểu được,
      // tốt hơn nhiều so với việc cắt socket giữa chừng.
      finish_reason: 'content_filter'
    }],
    tokengate: { blocked: true, criterion: criterion.id, name: criterion.name }
  };
}

export async function handleChatCompletions(req, res, { engine = 'auto', gateOpts = {} } = {}) {
  if (req.method !== 'POST') {
    return void res.writeHead(405, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: { message: 'method not allowed', type: 'invalid_request_error' } }));
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return void res.writeHead(400, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: { message: 'body không phải JSON hợp lệ', type: 'invalid_request_error' } }));
  }

  const ctl = new AbortController();
  req.on('close', () => ctl.abort());

  let upstream;
  try {
    upstream = await fetch(UPSTREAM(), {
      method: 'POST', signal: ctl.signal,
      headers: upstreamHeaders(req),
      body: JSON.stringify(payload)
    });
  } catch (err) {
    if (ctl.signal.aborted) return;
    return void res.writeHead(502, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: { message: `không gọi được upstream: ${err.message}`, type: 'upstream_error' } }));
  }

  // Lỗi upstream chuyển thẳng về client, đừng nuốt.
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return void res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' })
      .end(text);
  }

  // Không stream: gom cả response rồi kiểm MỘT lần. Rẻ hơn nhiều và đúng hơn —
  // không có mắt người đang đọc dần thì chẳng có gì để chặn trước.
  if (!payload.stream) {
    const body = await upstream.json();
    const text = (body.choices ?? []).map((c) => {
      const m = c.message ?? {};
      return (m.content ?? '') + (m.tool_calls ?? []).map((tc) => (tc.function?.name ?? '') + (tc.function?.arguments ?? '')).join('');
    }).join('\n');

    const v = await evaluate(text, engine);
    if (v.tripped) {
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        ...body,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '[tokengate: phản hồi bị chặn do vi phạm chính sách nội dung]' },
          finish_reason: 'content_filter'
        }],
        tokengate: { blocked: true, criterion: v.tripped.id, name: v.tripped.name, engine: v.engine }
      }));
    }
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  }

  // Stream: chunk chỉ rời proxy sau khi lô của nó và mọi lô trước đó All Pass.
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });

  const write = (s) => { if (!res.writableEnded) res.write(s); };
  let tripped = null;

  try {
    await runCircuitBreaker({
      ...gateOpts,
      source: upstreamItems(upstream.body),
      evaluate: (t) => evaluate(t, engine),
      abortUpstream: () => ctl.abort(),
      emit: (e) => {
        if (e.type === 'token') {
          for (const item of e.chunk) write(item.raw); // nguyên văn, đúng thứ tự
        } else if (e.type === 'blocked' || e.type === 'replaced') {
          tripped = e.criterion;
        }
      }
    });
  } catch (err) {
    if (!ctl.signal.aborted) {
      write(`data: ${JSON.stringify({ error: { message: String(err.message || err), type: 'upstream_error' } })}\n\n`);
    }
  }

  if (tripped) write(`data: ${JSON.stringify(blockedChunk(payload.model, tripped))}\n\n`);
  write('data: [DONE]\n\n');
  res.end();
}
