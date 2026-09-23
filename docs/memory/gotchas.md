# Gotchas

Recurring traps. When one bites twice, promote it to a rule in AGENTS.md.

- **Claude as a guardrail can refuse to guard.** Opus returned `stop_reason: "refusal"` on the
  `harmful` scenario; the cell passed only via local fallback. Always surface which engine
  actually ran (`evaluate()` returns `engine`), never the configured one.
- **`effort` param 400s on Haiku 4.5 / Sonnet 4.5.** `claude-guard.js` gates it with `SUPPORTS_EFFORT`.
- **Latency is network-bound.** Jev ≈ 79ms compute + ≈190ms RTT from Vietnam. Code changes won't
  hit the 35ms target; colocation will. Don't "optimize" code for it.
- **Tests must stay offline.** `test.js` blanks `JEV_API_KEY`; live smoke only with `SCB_TEST_JEV=1`.
- **Local regex false positives** (from `node eval.js`, 2026-09-23: 2/14 benign cases blocked):
  - CRIT-03 fires on a *published* promo ("giảm 30%") — the regex can't know it's public.
  - CRIT-01 fires on the phrase "system prompt" in an explanatory answer.
  Local is a safety net, not a moderator; fix at the semantic engine or with `unless`, and don't
  widen regexes without re-running `eval.js`.
- **Fixed window misses cross-response violations.** Raising `LOOKBACK` trades throughput.
