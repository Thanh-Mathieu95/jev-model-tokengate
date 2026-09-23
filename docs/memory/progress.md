# Progress

Newest first. One entry per task: date, what changed, what's next.

## 2026-09-23 — agent workflow scaffolding
- Added `AGENTS.md`, `docs/memory/` (INDEX, decisions, gotchas, progress).
- Added `eval.js`: 20 labelled cases (14 hard negatives, 6 violations) through the real breaker.
  Local engine: 2/14 false positives, 0/6 misses.
- Next: run `node eval.js jev claude` with keys; grow `CASES` toward 200–500 real responses (Roadmap).

## Earlier (from git history)
- OpenAI-compatible proxy `/v1/chat/completions`; external policy file; quadratic-cost fix;
  README rewritten in English.
