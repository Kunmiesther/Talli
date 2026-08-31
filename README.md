# Talli

Talli is a voice-first conversational credit ledger for informal traders who sell goods on credit and keep state in notebooks, memory, and informal verbal updates.

## What this repository contains

- A deterministic ledger domain model with event history.
- Safe action validation and mutation boundaries.
- Provider-backed baseline and advanced interpreter interfaces.
- A locked benchmark fixture format for multi-turn evaluation scenarios.
- A reproducible test harness for the ledger invariants and benchmark controls.

## Architecture

### Core approach

The system is intentionally split into:

1. `interpreter` layer
2. `action validation` layer
3. `ledger mutation` layer
4. `projection / verification` layer
5. `benchmark / evaluation` layer

The advanced model does not write state directly. It produces structured actions that are validated and only then applied.

### Current implementation choices

- TypeScript for all domain and harness code.
- Zod for runtime schemas.
- Event-sourced ledger history with deterministic projection.
- OpenAI-compatible structured intent provider with bounded retries, JSON-mode requests, and Zod validation.
- Deterministic compact context selection for the advanced interpreter.
- A compact model-facing `LedgerIntent` contract compiled into the internal ledger action schema by deterministic application code.
- A JSON-file persistence pattern is prepared through environment variables, while the domain remains storage-agnostic.
- No frontend styling work is started in this phase.

### Baseline vs advanced

- Baseline: a single-turn structured extraction baseline. It sees the utterance plus the fixed benchmark clock and produces a compact `LedgerIntent`, but no ledger history or entity cache.
- Advanced: a context-aware structured interpreter that receives a compact in-process retrieval package derived from current ledger state, recent turns, and relevant event history before the same intent compiler maps it into the internal action schema.

Both interfaces return the same action schema so the same benchmark scenarios can be run through either path later.

## Domain model

The domain preserves:

- Customer
- Obligation
- Payment
- LedgerEvent
- Correction / Amendment
- ClarificationRequired

Money is stored only as integer minor units.

## Safety boundary

Unsafe or ambiguous commands must not mutate financial state. The ledger application layer must return a clarification result instead of guessing when identity or target obligation resolution is not deterministic.

## Benchmark & Metrics

The benchmark is frozen before model testing so the evaluator measures the product instead of moving ground truth. Each scenario is deterministic, uses a fixed reference clock, and carries a fully specified expected action plus expected ledger state after every turn.

The eight locked failure modes are:

1. Simple new credit.
2. Partial payment.
3. Full settlement.
4. Correction.
5. Repeat customer, new obligation.
6. Natural reference resolution.
7. Ambiguous same-name customer requiring abstention.
8. Hard Nigerian Pidgin multi-turn flow.

Metrics:

- `LSA` is the percentage of turns whose canonical ledger state exactly matches the expected canonical state.
- `UMR` is the percentage of abstention-required turns that caused a prohibited financial mutation. If there are no abstention-required turns, the benchmark reports `N/A`.
- `Action Accuracy` is a diagnostic metric that compares the canonical expected action against the canonical actual action.

The benchmark uses a fixed reference datetime of `2026-08-29T09:00:00+01:00` in `Africa/Lagos` so temporal phrases such as `Friday`, `tomorrow`, and `before Monday` are reproducible.

Run the benchmark with:

```bash
npm run benchmark
```

Use `TALLI_INTERPRETER_MODE=perfect|wrong|unsafe|baseline|advanced` to switch interpreters and `TALLI_BENCHMARK_OUTPUT=json` for machine-readable output.
`TALLI_INTERPRETER_MODE=unsaf` is accepted as an alias for `unsafe`.

The real-model modes require credentials:

- `OPENAI_API_KEY`
- `OPENAI_MODEL` with `gpt-5` as the default
- `OPENAI_BASE_URL` for an OpenAI-compatible endpoint override
- `TRANSCRIPTION_BASE_URL` for voice-note transcription; it can fall back to `OPENAI_BASE_URL`
- `TRANSCRIPTION_MODEL` for voice-note transcription when you are not using OpenAI or Groq defaults

Voice transcription defaults are provider-aware:

- OpenAI-compatible OpenAI endpoints use `whisper-1`
- Groq uses `whisper-large-v3-turbo`
- other OpenAI-compatible endpoints must set `TRANSCRIPTION_MODEL` explicitly

If those values come from `.env`, the loader strips surrounding quotes before creating the provider.

When `TALLI_TRAJECTORY_DIR` is set, the benchmark runner writes sanitized JSON trajectory artifacts for the run.

## Setup

```bash
npm install
```

## Commands

```bash
npm run build
npm run typecheck
npm run lint
npm test
npm run benchmark
```

## Environment variables

See `.env.example` for the initial configuration pattern.

## Running Talli locally

```bash
npm install
npm run demo:seed
npm run dev:api
npm run demo
npm run demo:reset
npm run typecheck
npm run lint
npm test
```

Useful environment variables:

- `TALLI_DATA_DIR` or `TALLI_LEDGER_FILE` to control where the local event store lives.
- `OPENAI_API_KEY`, `OPENAI_MODEL`, and `OPENAI_BASE_URL` for live provider-backed interpretation.
- `TRANSCRIPTION_BASE_URL` and `TRANSCRIPTION_MODEL` for Telegram voice-note transcription.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME` for the Telegram polling worker and deep links.
- `SESSION_SECRET` for the web API startup guard.
- `TALLI_STORAGE_DRIVER=supabase` with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for Supabase-backed persistence.
- `TALLI_PORT` or `PORT` for the local HTTP API.

Local startup commands:

```bash
npm run dev:api
npm run dev:telegram
```

The demo and API both use the same text-first runtime path, so typed input and the future voice transcript flow will hit the same message endpoint.

Current real-model experiment status:

- Groq worked with the OpenAI-compatible provider after quote-stripping the local `.env` values.
- Provider/model/settings: `OPENAI_BASE_URL=https://api.groq.com/openai/v1`, `OPENAI_MODEL=openai/gpt-oss-120b`, `temperature=0`, `top_p=1`, `response_format=json_object` with bounded retries.
- Baseline Experiment 1: `LSA=5.6%`, `Action Accuracy=0%`, `abstentionRequiredTurnCount=1`, `unsafeMutationCount=0`, `UMR=0`, `providerFailures=17`, `schemaInvalidResponses=17`, `retries=2`, `latencyMs=4198`, `totalTokens=6910`.
- Advanced v1 Experiment 1: `LSA=5.6%`, `Action Accuracy=0%`, `abstentionRequiredTurnCount=1`, `unsafeMutationCount=0`, `UMR=0`, `providerFailures=16`, `schemaInvalidResponses=18`, `retries=2`, `latencyMs=2281`, `totalTokens=5185`.
- Contract smoke suite: 4/4 live calls passed after the compact contract and deterministic date normalization were in place.
- Baseline v2: `LSA=11.1%`, `Action Accuracy=5.6%`, `abstentionRequiredTurnCount=1`, `unsafeMutationCount=0`, `UMR=0`, `providerFailures=4`, `schemaInvalidResponses=1`, `rateLimitFailures=3`.
- Advanced v2: `LSA=5.6%`, `Action Accuracy=0%`, `abstentionRequiredTurnCount=1`, `unsafeMutationCount=0`, `UMR=0`, `providerFailures=13`, `schemaInvalidResponses=6`, `rateLimitFailures=13`.
- Saved evidence:
  - `artifacts/experiments/baseline-v1.json`
  - `artifacts/experiments/advanced-v1.json`
  - `artifacts/experiments/baseline-v2.json`
  - `artifacts/experiments/advanced-v2.json`
  - `artifacts/experiments/contract-smoke.json`
  - `artifacts/trajectories/`
- Run commands:
  - `TALLI_INTERPRETER_MODE=baseline`
  - `TALLI_INTERPRETER_MODE=advanced`
  - `npm run benchmark`
  - `npm run smoke:contract`

## Tests

Current tests focus on the ledger domain:

- create debt
- partial payment
- full payment
- correction
- repeat obligations for the same customer
- no mutation after ambiguity
- invalid overpayment behavior
- balance consistency
- audit history preservation

The benchmark tests also verify:

- the eight locked scenarios are complete and deterministic
- perfect controls score 100% LSA and 0% UMR
- wrong controls reduce accuracy
- unsafe controls produce a non-zero UMR
- canonical state comparison ignores audit-only metadata
- abstention turns preserve financial state

## Deferred, not removed

- Voice transcription integration
- SQLite/Prisma-backed persistence
- Web frontend and visual design
- Production authorization, sync, and multi-device workflows
