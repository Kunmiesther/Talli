# Talli

Talli is a voice-first conversational credit ledger for informal traders who sell goods on credit and keep state in notebooks, memory, and informal verbal updates.

## What this repository contains

- A deterministic ledger domain model with event history.
- Safe action validation and mutation boundaries.
- Baseline and advanced interpreter interfaces.
- A benchmark fixture format for multi-turn evaluation scenarios.
- A reproducible test harness for the ledger invariants.

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
- A JSON-file persistence pattern is prepared through environment variables, while the domain remains storage-agnostic.
- No frontend styling work is started in this phase.

### Baseline vs advanced

- Baseline: a text-only structured extraction baseline with no persistent conversational reasoning.
- Advanced: a context-aware structured interpreter interface that can consume ledger history and conversation memory.

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

## Benchmark

The benchmark fixture format supports:

- scenario metadata
- starting ledger state
- ordered turns
- input text
- language marker
- expected action
- expected ledger snapshot after each turn
- mutation vs abstention
- evaluator notes

The current seed benchmark is drafted for review and should not be treated as final ground truth yet.

## Metrics

- `LSA` - Ledger State Accuracy
- `UMR` - Unsafe Mutation Rate

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

## Deferred, not removed

- Voice transcription integration
- SQLite/Prisma-backed persistence
- Real LLM provider wiring
- Web frontend and visual design
- Production authorization, sync, and multi-device workflows
