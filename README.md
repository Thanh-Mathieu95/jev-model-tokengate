# tokengate

> Every token passes the gate before the screen.

An OpenAI-compatible proxy that sits between your LLM and your users. It evaluates each
sliding window of tokens **while the response is still streaming** and cuts the stream
**before** a violating token can reach the screen.

```
LLM ──stream──► [ sliding buffer ] ──► [ gate ] ──► client
                 tokens pending          │
                                    blocked here
```

![race benchmark](docs/race.png)

Same attack prompt, two architectures side by side. **Left (post-hoc):** the API key
`sk-proj-...` and `DB_PASSWORD` render in full, and the "content removed" notice arrives
2.98s later — 173 characters already leaked. **Right (tokengate):** the stream is cut inside
the buffer. **0 characters leaked.**

---

## The problem

LLM apps stream tokens to the screen as they are generated (30–60ms/token) to cut
time-to-first-token. Conventional guardrails are **post-hoc**: they buffer a sentence, send it
to a second LLM (Llama-Guard, GPT-4o-mini), wait 850–1600ms, then order a redaction. By then
18–35 sensitive tokens have been on screen. The user has read them, screenshotted them, or
recorded them.

The industry builds a **detective** control and sells it as a **preventive** one.

> **Deleting a secret from the screen is not security. Keeping it off the screen is.**

## The solution

Don't moderate faster — moderate **before release**. Tokens leaving the LLM are held in a small
sliding buffer, pending verification. When the buffer fills, the full criteria matrix is scored
in parallel; only on *All Pass* is that batch released. On a violation the buffer is dropped,
the client stream is cut, and an abort is sent upstream so you stop paying for generation.

The consequence that matters: **leakage is independent of evaluator latency.** A slow engine
makes the stream stutter; it does not leak a single extra token.

## Results

| Goal | Target | Measured | |
|---|---|---|---|
| **Zero leakage** — sensitive tokens rendered | 0 | **0** across 5 scenarios × 3 engines | ✅ |
| **Schema reliability** — well-formed verdicts | 100% | **100%** (Jev noul 0–1; Claude strict tool use) | ✅ |
| **Classification** on the scenario set | — | **5/5** on all three engines | ✅ |
| **Interception latency** | ≤ 35ms | **~300ms** (Jev over the public internet, 277–345ms) | ❌ |

The latency target is **missed, and not fixable in code**. Broken down: ~79ms is Jev compute,
~190ms is network RTT from Vietnam. Hitting 35ms requires colocating the proxy with the
evaluator. These are real numbers from an ordinary machine, not slideware.

---

## Use it

```bash
docker build -t tokengate . && docker run -p 8787:8787 \
  -e JEV_API_KEY=... \
  -e UPSTREAM_URL=https://api.openai.com/v1/chat/completions \
  tokengate
```

Then change **one line** in your existing app:

```python
client = OpenAI(base_url="http://localhost:8787/v1")   # instead of api.openai.com
```

That's it. Upstream chunks are **replayed verbatim** after verification rather than rebuilt, so
`id`, `usage`, `finish_reason` and `tool_calls` all survive.

- **A violation yields `finish_reason: "content_filter"`** then `[DONE]` — standard OpenAI, so
  existing SDKs handle it. Better than killing the socket mid-response.
- **`tool_calls` are inspected too.** A model can hide a key in a function argument, so the gate
  reads `function.arguments`, not just `content`.
- **`stream: false` takes the cheap path:** buffer the whole response, evaluate once.

Without `UPSTREAM_KEY` the proxy forwards the client's `Authorization` header, so it can serve
multiple tenants while holding no keys of its own.

> The proxy does **not** authenticate its own callers. Put it behind your existing API gateway.

## See it

```bash
npm install && npm start     # http://localhost:8787
```

Runs with no API key at all — mock LLM plus the local heuristic. The dashboard has two
buttons: *Chạy đối đầu* races post-hoc against inline on the same prompt, and *So mọi engine*
runs the full benchmark server-side, streaming results into a table row by row.

```bash
npm test                   # core + config + proxy (offline, deterministic, no credits)
SCB_TEST_JEV=1 npm test    # plus a live Jev smoke test
node bench.js              # CLI benchmark
```

---

## Engines

One gate, swappable engines — all three return five 0–1 scores compared against `threshold`.
Select via the **Engine B** dropdown, `?engine=`, or `SCB_ENGINE`.

| Engine | Mechanism | median p50 | Correct | Leaked |
|---|---|---|---|---|
| `local` | regex | **0.03 ms** | 5/5 | 0 |
| `jev` | TypeSafe Jev, latent space, one call for all 5 criteria | **308 ms** | 5/5 | 0 |
| `claude` (haiku-4-5) | LLM guardrail, strict tool use | **1,554 ms** | 5/5 | 0 |
| `claude` (opus-5) | LLM guardrail, strict tool use | **2,746 ms** | 5/5\* | 0 |

`local` is a fallback, not a moderator — it exists so the demo runs offline and so the system
never fails open when a remote engine dies.

![engine comparison](docs/bench.png)

The *Leaked* column is green for every engine even though p50 spans **five orders of
magnitude**. That is the architectural claim, and this is the measurement backing it.

### Finding: the guardrail refuses to guard

The `*` on Opus 5: on the `harmful` scenario Claude returned `stop_reason: "refusal"`
(category `cyber`) — its own safety classifier blocked it from even *evaluating* zero-day
exploit content. The guardrail fell back to the local heuristic, so that cell passed on the
fallback, not on Claude.

This is a systemic risk of using a general-purpose LLM as a moderator: **the more dangerous the
content, the more likely the engine walks away** — exactly when you need it, and silently if you
don't surface fallbacks. A dedicated classifier (Jev) and a small model (Haiku 4.5) did not do
this.

---

## Cost on long responses

Calling an evaluator repeatedly over a growing text is quadratic if done naively — the trap
that short demos hide. tokengate avoids it three ways: each pass sends only `LOOKBACK` recent
tokens plus the current batch; upstream reading runs concurrently with evaluation
(`PIPELINE_DEPTH` overlapping passes, **committed in order**, so the zero-leak guarantee is
unchanged); and batches grow when the evaluator is slow (`MAX_CHUNK`), so cost shrinks instead
of exploding.

400-token response, 40ms/token, measured 19.3s baseline:

| Evaluator | | Calls | Chars sent | Added latency |
|---|---|---|---|---|
| Jev 300ms | naive | 50 | 56,278 (24.6× the text) | +0.30s |
| Jev 300ms | **tokengate** | 50 | **6,726 (2.9×)** | **+0.11s** |
| Opus 2,700ms | naive | 50 | 56,278 (24.6×) | +116.51s |
| Opus 2,700ms | **tokengate** | **15** | **3,522 (1.5×)** | **+2.78s** |

("naive" = full context, no batching, no pipeline, simulated via
`maxChunk=windowSize, lookback=Infinity, depth=1`. A truly naive version also blocks upstream
reads during evaluation, so its real numbers are worse than shown.)

With Jev the gate is essentially free. With an engine 9× slower it is still usable — +2.78s
instead of +116s. **Trade-off:** a fixed window means violations only visible across the whole
response will slip through. Raise `LOOKBACK` at the cost of throughput.

---

## Criteria

Five by default, shared by all engines: system-prompt exfiltration, secret/credential leak,
unauthorized pricing commitments (replaced rather than cut), PII disclosure, and harmful
instructions (cut plus security log).

Policies differ per deployment, so they live outside the source. Copy
`tokengate.config.example.json` to `tokengate.config.json`, or point `TOKENGATE_CONFIG` at your
own file:

```json
{
  "criteria": [
    {
      "id": "internal-docs",
      "when": "The content quotes an unpublished roadmap or unreleased financial figures.",
      "unless": "The content only uses publicly announced information.",
      "threshold": 0.85,
      "action": "block",
      "patterns": [{ "re": "roadmap 2027", "flags": "i" }]
    }
  ]
}
```

`id` and `when` are required. `name` defaults to `id`, `threshold` to `0.8`, `action` to
`block` (`block` | `replace` | `block+log`). `patterns` are regex fallbacks for the `local`
engine — a string, or `{ re, flags, score }`. A config file **replaces** the defaults entirely.

**A bad config refuses to start the server.** Deliberately: silently dropping a malformed
criterion is a security hole nobody knows about. Startup errors name the file, the criterion
index and the offending field. (Runtime messages and source comments are in Vietnamese.)

---

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8787` | |
| `WINDOW_SIZE` | `8` | minimum tokens buffered per evaluation |
| `MAX_CHUNK` | `WINDOW_SIZE × 4` | ceiling per pass; slower engine → bigger batches, fewer calls |
| `LOOKBACK` | `WINDOW_SIZE × 2` | recent tokens sent as context |
| `PIPELINE_DEPTH` | `2` | overlapping evaluations (commit stays in order) |
| `SCB_ENGINE` | `auto` | `auto` = Jev when keyed, else local |
| `TOKENGATE_CONFIG` | `tokengate.config.json` | policy file; absent → built-in criteria |
| `JEV_API_KEY` / `JEV_URL` / `JEV_MODEL` | — / `…/v1/systemone` / `jev-latest` | enables `jev` |
| `JEV_TIMEOUT_MS` | `1500` | on timeout → local fallback, never fail-open |
| `ANTHROPIC_API_KEY` / `CLAUDE_MODEL` | — / `claude-opus-5` | enables `claude` |
| `UPSTREAM_URL` / `UPSTREAM_KEY` / `UPSTREAM_MODEL` | — | unset → mock LLM |

Core files: `breaker.js` (buffer + switch), `proxy.js` (OpenAI wire format), `criteria.js`
(policy loading and validation), `evaluator.js` (engine selection, fail-closed),
`claude-guard.js`, `upstream.js`, `bench.js`, `server.js`, `public/` (dashboard), and three
`test*.js` files using plain `assert`. The only dependency is `@anthropic-ai/sdk`, needed for
the `claude` engine; everything else is stdlib.

## Known limits

- **The false-positive rate is unmeasured.** Five scenarios are not an eval set. A guardrail
  that truncates 1% of legitimate answers is worse than none. This matters more than latency.
- **`local` is regex**, a safety net rather than a moderator.
- **Fixed sliding window** — violations only apparent across the whole response slip through.
- **No auth or rate limiting** on the proxy; it belongs behind a gateway.
- **The 35ms target is untested** without infrastructure colocated with the evaluator.

## Roadmap

A labelled eval set of 200–500 real responses to measure false positives; colocated deployment
to test the latency target honestly; packaging as a filter for existing LLM gateways (LiteLLM,
Portkey) instead of another service to run; runtime-tunable thresholds with a flag-only mode.

## License

MIT — see [LICENSE](LICENSE).
