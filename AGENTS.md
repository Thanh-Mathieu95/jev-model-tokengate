# AGENTS.md

tokengate: an OpenAI-compatible proxy that scores each sliding window of a streaming LLM
response and cuts the stream **before** a violating token reaches the client. README.md explains
the product; this file is for the agent working on it.

## Before you start

Read `docs/memory/INDEX.md`, then open only the memory files your task needs.

## Commands

```bash
npm install
npm start            # http://localhost:8787, mock LLM + local engine, no keys needed
npm test             # test.js + test-config.js + test-proxy.js — offline, deterministic, must pass
node eval.js         # false-positive / miss rate on labelled cases (local engine)
node eval.js jev     # same, on an engine with a key
node bench.js        # 5 scenarios × every keyed engine: correctness, leakage, latency
```

`npm test` forces the local engine, so it never needs or spends API keys. CI runs it on Node 22.

## Architecture

```
upstream.js ─tokens─► breaker.js ─window─► evaluator.js ─► jev | claude-guard.js | local regex
 (mock/live)          (buffer, pipeline,     (engine pick,        ▲
                       commit in order)       fail-closed)   criteria.js (policy, config file)
proxy.js   — POST /v1/chat/completions, replays upstream chunks verbatim after the gate
server.js  — HTTP: static dashboard (public/), race + bench SSE, proxy route
```

## Invariants — do not break

- **Zero leakage.** A token is emitted only after its window passed. Pipelined evaluations
  commit **in order**. Any change to `breaker.js` must keep `stats.leakedChars === 0` in tests.
- **Fail closed.** A remote engine that errors, times out, or refuses falls back to local regex —
  never passes content through unchecked.
- **Bad config refuses to start.** Never silently drop a malformed criterion.
- **Verbatim replay** in `proxy.js`: don't rebuild chunks; `id`, `usage`, `tool_calls` must survive.
  `tool_calls[].function.arguments` is inspected like `content`.

## Conventions

- ESM, Node 22, stdlib first. The only dependency is `@anthropic-ai/sdk`; ask before adding one.
- Tests are plain `node:assert` scripts, no framework. New logic gets one check in the matching
  `test*.js`; a new eval case goes in `eval.js` `CASES`.
- Source comments and runtime messages are Vietnamese; README and this file are English.
- Keys live only in `.env` (gitignored). Never commit `.env` or `tokengate.config.json` with secrets.
- Report measured numbers only. A target that was missed stays marked missed in the README.

## After a task

Append one entry to `docs/memory/progress.md`. If you hit a trap others will hit, add it to
`gotchas.md`; if you made a choice with a rejected alternative, add it to `decisions.md`.
