# Trajectory Artifacts

This directory stores sanitized benchmark trajectory JSON files produced by `src/benchmark/run.ts` when `TALLI_TRAJECTORY_DIR` is set.

Each file contains:

- run metadata
- the selected interpreter mode
- per-scenario metrics
- per-turn inputs
- expected and actual canonical actions
- expected and actual canonical snapshots
- provider and validation diagnostics when available

The checked-in files here are representative control-mode traces generated from the locked benchmark. No secrets are included.
