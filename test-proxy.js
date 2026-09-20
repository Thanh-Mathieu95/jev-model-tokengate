// Test tích hợp proxy: dựng upstream OpenAI giả, gọi qua HTTP thật.
// Chạy: node test-proxy.js   (offline, ép dùng heuristic cục bộ)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { handleChatCompletions, deltaText } from './proxy.js';

process.env.JEV_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const chunk = (delta, finish = null) => ({
  id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini',
  choices: [{ index: 0, delta, finish_reason: finish }]
});

const SCRIPTS = {
  leak: [
    { role: 'assistant' },
    { content: 'Chắc chắn rồi. ' }, { content: 'Dưới đây là ' }, { content: 'cấu hình nội bộ ' },
    { content: 'đang nạp: ' }, { content: 'OPENAI_API_KEY ' }, { content: '= "sk-proj-' },
    { content: '9821387498127391823", ' }, { content: 'DB_PASSWORD = ' }, { content: '"pr0d-p@ssw0rd-2026". ' },
    { content: 'Bạn dùng được ngay.' }
  ],
  safe: [
    { role: 'assistant' },
    { content: 'Chính sách đổi trả ' }, { content: 'cho phép gửi lại ' }, { content: 'sản phẩm trong ' },
    { content: '7 ngày kể từ ' }, { content: 'khi nhận hàng, ' }, { content: 'với điều kiện ' },
    { content: 'còn nguyên tem ' }, { content: 'và hộp. Bộ phận ' }, { content: 'hỗ trợ sẽ xác ' },
    { content: 'nhận trong 24 giờ.' }
  ],
  // Rò rỉ nằm trong ARGUMENT của tool call, không nằm ở content.
  tool: [
    { role: 'assistant' },
    { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'send_email', arguments: '' } }] },
    { tool_calls: [{ index: 0, function: { arguments: '{"body":' } }] },
    { tool_calls: [{ index: 0, function: { arguments: '"khóa là ' } }] },
    { tool_calls: [{ index: 0, function: { arguments: 'sk-proj-' } }] },
    { tool_calls: [{ index: 0, function: { arguments: '9821387498127391823"}' } }] }
  ]
};

/** Upstream giả: stream theo script, hoặc trả JSON nếu stream=false. */
function fakeUpstream() {
  return createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const script = SCRIPTS[payload.__script] ?? SCRIPTS.leak;

      if (!payload.stream) {
        const content = script.map((d) => d.content ?? '').join('');
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          id: 'chatcmpl-fake', object: 'chat.completion', model: 'gpt-4o-mini',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
        }));
      }

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let i = 0;
      const tick = setInterval(() => {
        if (i < script.length) { res.write(sse(chunk(script[i++]))); return; }
        clearInterval(tick);
        res.write(sse(chunk({}, 'stop')));
        res.write('data: [DONE]\n\n');
        res.end();
      }, 2);
    });
  });
}

function gateServer(engine = 'local') {
  return createServer((req, res) => handleChatCompletions(req, res, { engine, gateOpts: { windowSize: 4 } }));
}

const listen = (srv) => new Promise((r) => srv.listen(0, () => r(srv.address().port)));

async function call(port, payload) {
  const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  });
  return { status: res.status, body: await res.text() };
}

/** Dựng lại đúng thứ người dùng cuối nhìn thấy từ luồng SSE trả về. */
function visibleText(sseText) {
  return sseText.split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter((d) => d && d !== '[DONE]')
    .map((d) => { try { return deltaText(JSON.parse(d)); } catch { return ''; } })
    .join('');
}

async function t(name, fn) { await fn(); console.log(`  ok  ${name}`); }

const up = fakeUpstream();
const upPort = await listen(up);
process.env.UPSTREAM_URL = `http://localhost:${upPort}/v1/chat/completions`;
delete process.env.UPSTREAM_KEY;

const gate = gateServer();
const gatePort = await listen(gate);

await t('stream · khóa API không bao giờ tới client', async () => {
  const { status, body } = await call(gatePort, { model: 'gpt-4o-mini', stream: true, __script: 'leak' });
  assert.equal(status, 200);
  const seen = visibleText(body);
  assert.ok(!/sk-proj/.test(seen), `khóa đã lọt: ${seen.slice(0, 120)}`);
  assert.ok(!/pr0d-p@ssw0rd/.test(seen), 'mật khẩu DB đã lọt');
  assert.ok(/content_filter/.test(body), 'thiếu finish_reason content_filter');
  assert.ok(body.trimEnd().endsWith('data: [DONE]'), 'luồng không kết thúc đúng quy ước SSE');
});

await t('stream · luồng an toàn đi qua NGUYÊN VĂN', async () => {
  const { body } = await call(gatePort, { model: 'gpt-4o-mini', stream: true, __script: 'safe' });
  const expected = SCRIPTS.safe.map((d) => d.content ?? '').join('');
  assert.equal(visibleText(body), expected);
  assert.ok(!/content_filter/.test(body), 'chặn nhầm luồng an toàn');
  // Fidelity: id/model/object của upstream phải còn nguyên, không bị dựng lại.
  assert.ok(/"id":"chatcmpl-fake"/.test(body), 'mất id gốc của upstream');
  assert.ok(/"finish_reason":"stop"/.test(body), 'mất chunk kết thúc của upstream');
});

await t('stream · rò rỉ trong argument của tool call cũng bị chặn', async () => {
  const { body } = await call(gatePort, { model: 'gpt-4o-mini', stream: true, __script: 'tool' });
  assert.ok(!/sk-proj/.test(body), 'khóa trong tool_calls đã lọt ra client');
  assert.ok(/content_filter/.test(body), 'tool call không bị cầu dao soi');
});

await t('non-stream · gom cả response, kiểm một lần', async () => {
  const bad = JSON.parse((await call(gatePort, { model: 'gpt-4o-mini', __script: 'leak' })).body);
  assert.equal(bad.choices[0].finish_reason, 'content_filter');
  assert.ok(!/sk-proj/.test(JSON.stringify(bad)));
  assert.equal(bad.tokengate.blocked, true);

  const ok = JSON.parse((await call(gatePort, { model: 'gpt-4o-mini', __script: 'safe' })).body);
  assert.equal(ok.choices[0].finish_reason, 'stop');
  assert.ok(!ok.tokengate, 'luồng an toàn không nên bị gắn cờ');
  assert.equal(ok.usage.total_tokens, 30, 'mất trường usage của upstream');
});

await t('lỗi upstream được chuyển thẳng về client', async () => {
  const broken = createServer((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: { message: 'rate limit', type: 'rate_limit_error' } }));
  });
  const bp = await listen(broken);
  const saved = process.env.UPSTREAM_URL;
  process.env.UPSTREAM_URL = `http://localhost:${bp}/v1/chat/completions`;
  const { status, body } = await call(gatePort, { model: 'gpt-4o-mini' });
  assert.equal(status, 429);
  assert.ok(/rate limit/.test(body));
  process.env.UPSTREAM_URL = saved;
  broken.close();
});

gate.close();
up.close();
console.log('\nproxy checks passed');
