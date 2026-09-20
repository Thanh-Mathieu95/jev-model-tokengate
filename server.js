import './startup-guard.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { evaluate } from './evaluator.js';
import { runCircuitBreaker, runTraditionalGuardrail } from './breaker.js';
import { openStream, SCENARIOS } from './upstream.js';
import { runBench, summarise, ready, ENGINES } from './bench.js';
import { handleChatCompletions } from './proxy.js';

const PORT = Number(process.env.PORT || 8787);
const WINDOW = Number(process.env.WINDOW_SIZE || 8);
// Ba núm vặn đánh đổi độ trễ / chi phí / độ chính xác — xem README.
const MAX_CHUNK = Number(process.env.MAX_CHUNK || WINDOW * 4);
const LOOKBACK = Number(process.env.LOOKBACK || WINDOW * 2);
const DEPTH = Number(process.env.PIPELINE_DEPTH || 2);
const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

async function serveStatic(req, res) {
  const name = req.url === '/' ? 'index.html' : req.url.replace(/^\/+/, '').split('?')[0];
  if (name.includes('..')) return void res.writeHead(400).end();
  try {
    const body = await readFile(PUBLIC + name);
    const ext = name.slice(name.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

function sseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
}

/** Chạy bench ngay trên server, đẩy từng dòng về UI khi có (Opus 5 mất vài phút). */
async function handleBench(req, res, url) {
  const asked = (url.searchParams.get('engines') || ENGINES.join(',')).split(',').filter(ready);
  sseHead(res);
  const send = (e) => { if (!res.writableEnded) res.write('data: ' + JSON.stringify(e) + '\n\n'); };
  send({ type: 'start', engines: asked, scenarios: Object.keys(SCENARIOS) });
  try {
    const rows = await runBench(asked, (row) => send({ type: 'row', row }));
    send({ type: 'done', summary: asked.map((e) => summarise(rows, e)) });
  } catch (err) {
    send({ type: 'error', message: String(err.message || err) });
  }
  res.end();
}

async function handleStream(req, res, url) {
  const arch = url.searchParams.get('arch') === 'traditional' ? 'traditional' : 'scb';
  const scenario = url.searchParams.get('scenario') || 'leak';
  const guardrailDelayMs = Number(url.searchParams.get('guardrailDelay') || 1200);
  const engine = url.searchParams.get('engine') || 'auto';

  sseHead(res);

  const ctl = new AbortController();
  req.on('close', () => ctl.abort());

  const t0 = performance.now();
  const emit = (e) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ ...e, t: +(performance.now() - t0).toFixed(1) })}\n\n`);
  };

  const source = openStream(scenario, SCENARIOS[scenario]?.prompt, { signal: ctl.signal });
  const common = {
    source, evaluate: (t) => evaluate(t, engine), emit,
    windowSize: WINDOW, maxChunk: MAX_CHUNK, lookback: LOOKBACK, depth: DEPTH
  };

  try {
    if (arch === 'scb') {
      await runCircuitBreaker({ ...common, abortUpstream: () => ctl.abort() });
    } else {
      await runTraditionalGuardrail({
        ...common, guardrailDelayMs,
        probe: (t) => evaluate(t, 'local')
      });
    }
  } catch (err) {
    if (!ctl.signal.aborted) emit({ type: 'error', message: String(err.message || err) });
  }
  res.end();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Đường proxy thật: ứng dụng có sẵn chỉ cần trỏ base_url vào đây.
  if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(req, res, {
      engine: url.searchParams.get('engine') || process.env.SCB_ENGINE || 'auto',
      gateOpts: { windowSize: WINDOW, maxChunk: MAX_CHUNK, lookback: LOOKBACK, depth: DEPTH }
    });
  }
  if (url.pathname === '/api/stream') return handleStream(req, res, url);
  if (url.pathname === '/api/bench') return handleBench(req, res, url);
  if (url.pathname === '/api/engines') {
    const has = (k) => Boolean(process.env[k]);
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([
      { id: 'local', label: 'Heuristic cục bộ (regex)', ready: true },
      { id: 'jev', label: 'TypeSafe Jev', ready: has('JEV_API_KEY') },
      { id: 'claude', label: `Claude (${process.env.CLAUDE_MODEL || 'claude-opus-5'})`,
        ready: has('ANTHROPIC_API_KEY') || has('ANTHROPIC_AUTH_TOKEN') }
    ]));
  }
  if (url.pathname === '/api/scenarios') {
    const list = Object.entries(SCENARIOS).map(([id, s]) => ({ id, label: s.label, prompt: s.prompt }));
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list));
  }
  return serveStatic(req, res);
});

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`Port ${PORT} đang bận. Dùng port khác: PORT=8788 npm start`);
  process.exit(1);
});

server.listen(PORT, () => {
  const mode = process.env.UPSTREAM_URL ? `proxy → ${process.env.UPSTREAM_URL}` : 'mock LLM';
  const engine = process.env.JEV_API_KEY ? 'Jev API' : 'local heuristic';
  console.log(`tokengate dashboard : http://localhost:${PORT}`);
  console.log(`tokengate proxy     : http://localhost:${PORT}/v1  (trỏ base_url vào đây)`);
  console.log(`[${mode} | evaluator: ${engine} | window: ${WINDOW}]`);
});
