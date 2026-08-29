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
