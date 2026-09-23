# Decisions

Each: what was chosen, what was rejected, why.

- **Inline gate, not post-hoc moderation.** Tokens are held until their window passes. Rejected:
  redact-after-render — the user has already seen the secret. Leakage becomes independent of
  evaluator latency; a slow engine only makes the stream stutter.
- **Fail closed to local regex.** Remote engine error/timeout/refusal → `evaluateLocal`. Rejected:
  fail open. Fallback is warned once (`warnOnce`) so nobody runs regex without knowing.
- **Lookback + pipeline + growing batches** in `runCircuitBreaker`. Rejected: resending the full
  text each pass (quadratic cost; +116s on Opus for 400 tokens vs +2.78s now).
- **OpenAI wire format, verbatim replay.** Drop-in via `base_url`. Violation →
  `finish_reason: "content_filter"` + `[DONE]` rather than killing the socket.
- **Policy in `tokengate.config.json`, JSON not YAML.** Node has no YAML parser; not worth a dependency.
  A config file replaces the defaults entirely; a bad one refuses to start.
- **Claude engine uses strict tool use** so verdicts are always 5 numbers in 0–1, never parsed prose.
- **No proxy auth / rate limiting.** It belongs behind an existing gateway.
