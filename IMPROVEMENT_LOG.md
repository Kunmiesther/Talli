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

- OpenAI-compatible structured action provider wired behind the interpreter contract
- Baseline prompt stays single-turn and receives only the utterance plus the fixed benchmark clock
- Structured responses are validated with Zod and retried in a bounded way
- Trajectory artifacts are emitted under `artifacts/trajectories/`
- Real-model benchmark execution is blocked because `OPENAI_API_KEY` is unset

## Milestone 3 - Advanced Talli v1

- Compact in-process retrieval package built from the current ledger snapshot, event history, and recent turns
- Stable customer and obligation IDs are surfaced in the prompt context
- Advanced prompt covers entity resolution, obligation/reference resolution, corrections, abstention, Pidgin, and temporal normalization
- Safe clarification fallback is returned when provider output is invalid or unavailable
- Real-model benchmark execution is blocked because `OPENAI_API_KEY` is unset
