# Improvement Log

## Milestone 0 - Foundation

- Event-sourced ledger
- Structured safe mutation boundary
- Ledger invariants
- Baseline / advanced interpreter interface

## Milestone 1 - Benchmark locked

- 8 predefined multi-turn scenarios
- Deterministic ground truth
- Evaluator validation controls
- Metrics: LSA, UMR, and Action Accuracy

## Milestone 2 - Real-model baseline

- Provider: Groq via OpenAI-compatible `OPENAI_BASE_URL=https://api.groq.com/openai/v1`
- Model: `openai/gpt-oss-120b`
- Compatibility change: strip surrounding quotes from `.env` values before constructing the provider
- Baseline prompt stayed single-turn and received only the utterance plus the fixed benchmark clock
- Structured responses were validated with Zod and retried in a bounded way
- Actual metrics: `LSA=5.6%`, `Action Accuracy=0%`, `abstentionRequiredTurnCount=1`, `unsafeMutationCount=0`, `UMR=0`, `providerFailures=17`, `schemaInvalidResponses=17`, `retries=2`, `latencyMs=4198`, `totalTokens=6910`
- Main failures:
  - simple extraction requests returned schema-invalid objects or clarification fallbacks instead of `CREATE_OBLIGATION`
  - one full-settlement turn returned a `RECORD_PAYMENT` action but still missed the expected canonical state
  - the ambiguous-customer abstention preserved state but did not match the expected clarification payload
- Trajectory artifacts are emitted under `artifacts/trajectories/`
- Evidence saved at `artifacts/experiments/baseline-v1.json`

## Milestone 3 - Advanced Talli v1

- Provider: Groq via OpenAI-compatible `OPENAI_BASE_URL=https://api.groq.com/openai/v1`
- Model: `openai/gpt-oss-120b`
- Compact in-process retrieval package built from the current ledger snapshot, event history, and recent turns
- Stable customer and obligation IDs were surfaced in the prompt context
- Advanced prompt covered entity resolution, obligation/reference resolution, corrections, abstention, Pidgin, and temporal normalization
- Safe clarification fallback was returned when provider output was invalid or unavailable
- Actual metrics: `LSA=5.6%`, `Action Accuracy=0%`, `abstentionRequiredTurnCount=1`, `unsafeMutationCount=0`, `UMR=0`, `providerFailures=16`, `schemaInvalidResponses=18`, `retries=2`, `latencyMs=2281`, `totalTokens=5185`
- Main failures:
  - every non-abstention scenario returned clarification instead of the intended mutation
  - the ambiguous-customer abstention again preserved state but missed the exact expected clarification payload
  - rate limits surfaced in the provider diagnostics on later turns
- Evidence saved at `artifacts/experiments/advanced-v1.json`

## Milestone 4 - Compact intent contract

- Observed failure: Experiment 1 was dominated by schema-invalid provider outputs and token pressure at the model/provider contract boundary.
- Hypothesis: the model should emit semantic intent while deterministic application code constructs the rich internal ledger action.
- Implementation: compact `LedgerIntent` model-facing schema, deterministic intent-to-action compiler, compressed prompt/context packages, richer provider diagnostics, and explicit 429 / `Retry-After` handling.
- Smoke suite: 4/4 live calls passed after date normalization was moved into deterministic code.
- Baseline v2 metrics: `LSA=11.1%`, `Action Accuracy=5.6%`, `abstentionRequiredTurnCount=1`, `unsafeMutationCount=0`, `UMR=0`, `providerFailures=4`, `schemaInvalidResponses=1`, `rateLimitFailures=3`.
- Advanced v2 metrics: `LSA=5.6%`, `Action Accuracy=0%`, `abstentionRequiredTurnCount=1`, `unsafeMutationCount=0`, `UMR=0`, `providerFailures=13`, `schemaInvalidResponses=6`, `rateLimitFailures=13`.
- Main takeaway: the compact contract improved provider reliability enough for smoke testing, but the advanced path still underperformed the baseline on the locked benchmark.
- Evidence saved at `artifacts/experiments/baseline-v2.json`, `artifacts/experiments/advanced-v2.json`, and `artifacts/experiments/contract-smoke.json`.

## Milestone 5 - Candidate-Based Resolution

- Observed failure: v2 still over-clarified and did not reliably outperform the baseline on entity, obligation, reference, and correction resolution.
- Hypothesis: the model should interpret language over a small deterministic candidate set instead of searching the raw ledger state.
- Implementation: deterministic candidate retrieval, candidate-centered advanced context, candidate validation in the compiler, and a dedicated advanced-only resolution smoke harness.
- Infrastructure interruption: the Groq provider path returned `fetch failed` and direct endpoint connectivity returned HTTP `000`, so the first v3 smoke could not reach a real model output.
- Provider fallback: `.env` was switched to OpenRouter with `OPENAI_BASE_URL=https://openrouter.ai/api/v1` and `OPENAI_MODEL=z-ai/glm-5.2:free`, which preserved the candidate-resolution architecture without changing benchmark fixtures.
- OpenRouter smoke: a direct JSON-mode connectivity check reached the provider but returned HTTP `429` with upstream rate-limit messaging; the five-case advanced smoke suite still surfaced provider failures and did not pass the success gate.
- Control benchmarks after the change stayed healthy: perfect `LSA=1.0`, wrong `LSA=0.0556`, unsafe `LSA=0.9444`, with the locked abstention turn count unchanged at `1`.
- Evidence saved at `artifacts/experiments/resolution-smoke-*.json` and `artifacts/trajectories/trajectory-resolution-smoke-*.json`.

## Milestone 6 - Product Runtime

- Implemented a persistent `TalliService` orchestration layer that loads and saves the event-sourced ledger, keeps bounded conversation state, and composes existing domain operations instead of duplicating business rules.
- Added a stable application-facing response contract for applied actions, clarification requests, safe no-ops, and sanitized provider failures.
- Added deterministic user confirmations for create, payment, settlement, correction, and ambiguity flows so the runtime can return natural text without another LLM call.
- Added a lightweight HTTP API, a text-first CLI/demo harness, demo seed/reset commands, and a clarification round-trip that preserves candidate context across turns.
- Persistence uses local event and session files with deterministic reload and corruption-safe handling; no Prisma/Postgres layer was added in this milestone.
- Runtime tests cover persistence, clarification, provider failure safety, demo reset, and API error shaping.
- Quality gate passed: `npm run typecheck`, `npm run lint`, `npm test` all green; benchmark controls stayed healthy after the runtime layer was added.
- Control runtime evidence recorded: perfect `LSA=1.0`, wrong `LSA=0.0556`, unsafe `LSA=0.9444`, with the locked abstention turn count unchanged at `1`.
- Evidence saved at `artifacts/experiments/control-perfect-runtime.json`, `artifacts/experiments/control-wrong-runtime.json`, `artifacts/experiments/control-unsafe-runtime.json`, and `artifacts/trajectories/trajectory-*-17_17_*.json`.
