# Talli Improvement Log

This log tracks how Talli changed from a basic event-sourced ledger into a state-aware conversational credit assistant.

The important part is not the number of features added. Each major change came from something observable: a benchmark failure, an unsafe edge case, provider instability, or a limitation in the previous architecture.

The benchmark was locked before the main model experiments began, so later versions could not improve their scores by changing the expected answers.

At a high level, the development path looked like this:

| Stage | Question | What the evidence showed | Decision |
| --- | --- | --- | --- |
| Foundation | Can financial state be changed safely and reproducibly? | Ledger invariants and event history gave Talli a deterministic core | Keep financial state outside the model |
| Benchmark | How will improvement be measured? | Ordinary action accuracy was not enough | Measure final ledger state and unsafe mutations |
| V1 Baseline | Can a model directly produce rich ledger actions? | Provider and schema failures dominated | Reduce the model's responsibility |
| V1 Advanced | Does adding history solve the problem? | More context did not overcome the brittle output contract | Change the contract before adding more context |
| V2 | Can the model return a smaller semantic intent instead? | Schema reliability improved, but contextual resolution remained weak | Introduce deterministic resolution candidates |
| V3 | Can candidate retrieval make context safer and smaller? | Architecture worked locally, but live evaluation was blocked by provider failures and rate limits | Keep the design, do not invent a benchmark win |
| Product Runtime | Can the evaluated architecture become a usable product? | Persistent state, clarification and deterministic confirmations worked together | Build the product around one shared ledger |

---

## Milestone 0: Build the financial core before the agent

Talli did not start with a prompt.

It started with the ledger.

The first milestone was to create a financial state layer that would remain predictable even if the language model was wrong, unavailable, or uncertain.

### What was built

The foundation included:

- an event-sourced ledger
- typed ledger actions
- money handling
- deterministic state projection
- ledger invariants
- a structured mutation boundary
- separate baseline and advanced interpreter interfaces

Instead of storing only the latest balance, Talli records the events that caused that balance.

A customer who owes $200 and later pays $50 is therefore represented conceptually as:

```text
CREATE_OBLIGATION $200
        ↓
RECORD_PAYMENT $50
        ↓
Outstanding balance = $150
```

The $150 balance is derived from history rather than replacing it.

### Why this mattered

This made the ledger, rather than the model, the authority on financial state.

The interpreter can propose what happened. The domain layer still decides whether the resulting action is valid.

That separation became important later when model outputs started failing in ways that would have been dangerous if they had been allowed to directly own the ledger.

### Decision carried forward

> **Use AI for interpretation. Keep financial state transitions deterministic.**

---

## Milestone 1: Lock the benchmark before tuning

Before optimizing prompts or choosing an advanced architecture, I froze the evaluation target.

The benchmark contains **8 predefined multi-turn scenarios and 18 turns**, each with deterministic expected ledger state.

It covers:

- new customer credit
- partial payments
- full settlement
- corrections
- repeat customers
- multiple obligations
- conversational references
- ambiguity that should trigger abstention
- a Pidgin multi-turn stress case

The expected state was fixed before the main model experiments started.

### Metrics

Three metrics were used.

#### Ledger State Accuracy

**LSA** measures whether the financially meaningful ledger state is correct after each turn.

It checks things such as:

- customer
- obligation
- payment
- outstanding amount
- settlement state
- due date

This became the primary metric because producing the right-looking action is not useful if the final ledger is wrong.

#### Unsafe Mutation Rate

**UMR** asks a different question:

> On turns where Talli should abstain or ask for clarification, did it mutate financial state anyway?

This became the safety metric.

#### Action Accuracy

Action Accuracy records whether the expected canonical action was produced. It remained useful diagnostically, but it was not treated as a replacement for final ledger correctness.

### Evaluator controls

The evaluator was tested with deliberately artificial interpreters:

```text
PerfectFixtureInterpreter
IntentionallyWrongInterpreter
UnsafeMutationInterpreter
```

The controls were important because they test the measurement system itself rather than assuming the evaluator is correct.

The later unsafe control produced one of the project's most useful findings:

```text
LSA: 94.44%
UMR: 100%
```

A system could therefore look excellent on aggregate accuracy while still making the unsafe decision on the one turn where it should refuse to act.

### Decision carried forward

The benchmark would stay fixed while the implementation changed around it.

---

# Experiment 1: Can the model own the full ledger action?

## Milestone 2: Real-model baseline

The first live-model experiment deliberately kept the baseline simple.

The model saw only:

- the current merchant utterance
- the fixed benchmark clock

It did not receive persistent ledger history or sophisticated resolution context.

### Provider

```text
Provider: Groq
Base URL: https://api.groq.com/openai/v1
Model: openai/gpt-oss-120b
```

A small compatibility fix was also required: quoted `.env` values had to be normalized before constructing the provider.

### Architecture

The model was asked to return the rich structured action expected by the ledger layer.

Responses were validated using Zod, with bounded retries for malformed output.

Conceptually:

```text
Merchant message
      ↓
Model
      ↓
Rich ledger action
      ↓
Schema validation
      ↓
Ledger
```

### Measured result

```text
Ledger State Accuracy:        5.6%
Action Accuracy:              0%
Abstention-required turns:    1
Unsafe mutations:             0
Unsafe Mutation Rate:         0
Provider failures:            17
Schema-invalid responses:     17
Retries:                      2
Latency:                      4198 ms
Total tokens:                 6910
```

Evidence:

```text
artifacts/experiments/baseline-v1.json
```

### What actually failed

The low score was not simply a matter of the model misunderstanding difficult conversations.

Even simple extraction requests frequently returned schema-invalid structures or fell back to clarification rather than producing `CREATE_OBLIGATION`.

One full-settlement turn did produce a `RECORD_PAYMENT` action, but the resulting canonical ledger state was still incorrect.

The ambiguity case was safer: the agent preserved state rather than mutating recklessly, but its clarification payload did not match the locked expected result.

### What I learned

The model was being asked to cross too large a boundary in one step.

It had to:

1. understand the merchant
2. resolve the intended target
3. normalize money and dates
4. choose the correct financial operation
5. construct the complete internal ledger schema

A failure anywhere in that sequence invalidated the whole action.

### Decision

Before abandoning the idea completely, the next experiment tested whether richer state context would solve enough of the problem to justify the large output contract.

---

## Milestone 3: Advanced Talli V1

The advanced path added persistent context while keeping the same rich-action output strategy.

The hypothesis was straightforward:

> If the baseline fails because it cannot remember enough, give the interpreter the relevant financial history.

### What changed

The advanced request included a compact package built from:

- the current ledger snapshot
- event history
- recent conversation turns
- stable customer IDs
- stable obligation IDs

The prompt also explicitly covered:

- entity resolution
- obligation resolution
- conversational references
- corrections
- abstention
- temporal normalization
- Pidgin expressions

If provider output was unavailable or invalid, the runtime returned safe clarification rather than inventing a financial action.

### Measured result

```text
Ledger State Accuracy:        5.6%
Action Accuracy:              0%
Abstention-required turns:    1
Unsafe mutations:             0
Unsafe Mutation Rate:         0
Provider failures:            16
Schema-invalid responses:     18
Retries:                      2
Latency:                      2281 ms
Total tokens:                 5185
```

Evidence:

```text
artifacts/experiments/advanced-v1.json
```

### What actually happened

The additional context did not solve the dominant failure.

Every non-abstention scenario still ended in clarification instead of the intended mutation.

The ambiguity turn again preserved state, but the exact clarification output did not satisfy the locked expected result.

Later turns also began surfacing provider rate limits.

### The important lesson

This result changed the direction of the project.

The obvious reaction would have been to keep making the advanced prompt larger. The evidence suggested the opposite.

Both the state-light baseline and the context-rich advanced version failed at almost the same boundary.

The problem was not simply **how much context the model saw**.

The model was still being asked to emit too much precise application structure.

### Decision

> **Shrink the model-facing contract before spending more time on prompt complexity.**

---

# Experiment 2: Give the model a smaller job

## Milestone 4: Compact Intent Contract

The next version changed the architecture rather than merely changing the prompt.

### Observed failure

V1 was dominated by:

- schema-invalid responses
- provider failures
- large structured output requirements
- token pressure
- model responsibility for details deterministic code could calculate more safely

### Hypothesis

The model should answer:

> **What does the merchant mean?**

It should not have to answer:

> **What exact internal ledger object should the application persist?**

### What changed

A smaller model-facing `LedgerIntent` schema was introduced.

The flow became:

```text
Merchant message
      ↓
Model
      ↓
Compact LedgerIntent
      ↓
Deterministic compiler
      ↓
Rich LedgerAction
      ↓
Ledger validation
```

Date normalization and other application-specific details were also moved into deterministic code.

Additional changes included:

- compressed prompt packages
- smaller context packages
- richer provider diagnostics
- explicit `429` handling
- `Retry-After` support
- deterministic intent-to-action compilation

### Contract smoke result

The focused live contract smoke suite reached:

```text
4 / 4 successful calls
```

after date normalization was moved out of the model contract.

That was the first clear evidence that reducing the model's responsibility improved the provider boundary.

### Baseline V2

```text
Ledger State Accuracy:        11.1%
Action Accuracy:              5.6%
Abstention-required turns:    1
Unsafe mutations:             0
Unsafe Mutation Rate:         0
Provider failures:            4
Schema-invalid responses:     1
Rate-limit failures:          3
```

### Advanced V2

```text
Ledger State Accuracy:        5.6%
Action Accuracy:              0%
Abstention-required turns:    1
Unsafe mutations:             0
Unsafe Mutation Rate:         0
Provider failures:            13
Schema-invalid responses:     6
Rate-limit failures:          13
```

Evidence:

```text
artifacts/experiments/baseline-v2.json
artifacts/experiments/advanced-v2.json
artifacts/experiments/contract-smoke.json
```

### What improved

The most important improvement was not the headline LSA number.

The provider boundary itself became substantially less brittle in the baseline path:

```text
V1 baseline schema-invalid responses: 17
V2 baseline schema-invalid responses: 1
```

The model had less structure to get wrong.

### What still failed

The advanced path still failed to reliably beat the baseline on:

- customer resolution
- obligation resolution
- references
- corrections

It also suffered heavily from rate limiting.

The compact intent contract fixed one problem, but persistent context alone still did not tell the model **which pieces of that context were likely to matter**.

### Decision

Instead of passing a broad ledger snapshot and asking the model to discover the target itself, Talli would retrieve a small set of plausible customers and obligations first.

---

# Experiment 3: Resolve candidates before interpretation

## Milestone 5: Candidate-Based Resolution

V3 focused on the part that V2 still handled poorly: identifying what an update refers to.

### Observed failure

Suppose the merchant says:

```text
She paid 20k from that money.
```

Even if the model understands that this describes a payment, the ledger still needs to answer:

```text
Who is "she"?
Which obligation is "that money"?
Is there one safe target or several plausible ones?
```

Dumping more raw state into a prompt does not necessarily make those questions easier.

### Hypothesis

The model should reason over a **small deterministic candidate set**, not search the entire ledger implicitly.

### What changed

Before calling the advanced interpreter, Talli now builds candidate sets for likely:

- customers
- open obligations
- references
- recent entities

The advanced context became candidate-centered, and the compiler validates references returned by the interpreter.

Conceptually:

```text
Ledger
   ↓
Deterministic candidate retrieval
   ↓
Small relevant context
   ↓
Advanced interpreter
   ↓
Compact intent
   ↓
Candidate validation
   ↓
Ledger action
```

A dedicated advanced-only resolution smoke harness was also added.

### Live evaluation interruption

The architecture was implemented, but the live experiment ran into infrastructure problems before a clean comparison could be produced.

The Groq provider path returned:

```text
fetch failed
```

and direct endpoint connectivity returned:

```text
HTTP 000
```

Rather than changing the benchmark, the provider configuration was switched to an OpenAI-compatible OpenRouter endpoint:

```text
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=z-ai/glm-5.2:free
```

The candidate-resolution architecture and benchmark fixtures were left unchanged.

The OpenRouter connectivity test reached the provider successfully but returned:

```text
HTTP 429
upstream rate limit
```

The five-case advanced resolution smoke therefore did not pass its live success gate.

### What I did not do

I did **not** report a V3 accuracy improvement.

The architecture may be stronger, but a benchmark number that was never successfully measured would not be evidence.

That distinction is important to the integrity of this log.

### Sanity check

After the architectural change, the deterministic benchmark controls remained healthy:

```text
Perfect control
LSA = 1.0

Wrong control
LSA = 0.0556

Unsafe control
LSA = 0.9444

Abstention-required turns = 1
```

So the evaluation system itself had not silently broken while the provider path was failing.

### Evidence

```text
artifacts/experiments/resolution-smoke-*.json
artifacts/trajectories/trajectory-resolution-smoke-*.json
```

### Decision

Candidate retrieval remained in Talli because it created a cleaner resolution boundary, but further provider chasing was no longer a useful use of development time.

The next question became more practical:

> **Can the architecture now support an actual persistent product?**

---

# Milestone 6: Turn the experiments into a product runtime

Until this point, most of the work focused on understanding and measuring the agent.

Milestone 6 turned those pieces into something that could maintain an actual ledger across conversations.

### TalliService

A persistent `TalliService` orchestration layer was introduced.

Its job is to compose the existing domain operations rather than recreate financial logic inside the application layer.

It handles:

- loading the ledger
- processing messages
- maintaining bounded conversation state
- preserving clarification context
- applying validated actions
- saving state
- returning a stable application response

### Application response contract

The runtime gained predictable responses for:

- successfully applied actions
- clarification requests
- safe no-ops
- sanitized provider failures

The product should not need another model call simply to explain that a $50 payment was recorded, so deterministic confirmations were added for:

- new credit
- payment
- settlement
- correction
- ambiguity

### Persistence

The first runtime storage layer used local event and session files.

This preserved:

- ledger events
- conversation state
- recent turns
- pending clarification context

Reload was deterministic, and corrupted data was handled safely.

No Prisma/Postgres layer was introduced during this milestone because the immediate goal was proving the application runtime rather than introducing another infrastructure dependency.

### Interfaces

Milestone 6 also added:

- HTTP API
- text-first CLI/demo harness
- demo seed/reset commands
- clarification round-trip support

A clarification could now survive across turns rather than becoming a dead-end message.

### Quality gate

After the runtime layer was introduced:

```text
npm run typecheck
npm run lint
npm test
```

all passed in the verified milestone environment.

The benchmark controls remained healthy.

### Runtime control evidence

```text
Perfect control
LSA = 1.0

Wrong control
LSA = 0.0556

Unsafe control
LSA = 0.9444

Abstention-required turns = 1
```

Evidence:

```text
artifacts/experiments/control-perfect-runtime.json
artifacts/experiments/control-wrong-runtime.json
artifacts/experiments/control-unsafe-runtime.json

artifacts/trajectories/trajectory-*-17_17_*.json
```

### What changed conceptually

This milestone turned Talli from an interpreter benchmark into a stateful application.

The important shift was that the architecture now had a complete loop:

```text
Merchant message
      ↓
Existing session + ledger state
      ↓
Interpretation
      ↓
Safe action or clarification
      ↓
Deterministic ledger mutation
      ↓
Persistent event history
      ↓
Merchant confirmation
      ↓
Next turn continues from the new state
```

---

# What the experiments changed

Looking only at features would make Talli's development look fairly linear.

It was not.

The most important architecture decisions came from failed approaches.

### I started by giving the model more responsibility

That produced a brittle structured-output boundary.

### I then tried giving the advanced model more context

The context became richer, but the same schema boundary still failed.

### I reduced the model's responsibility

Provider contract reliability improved dramatically.

### Then resolution became the visible problem

So the system began retrieving likely customers and obligations before interpretation.

### Provider availability eventually became the experiment bottleneck

Instead of repeatedly changing providers until one produced a flattering run, the provider-limited V3 result was left inconclusive.

### Meanwhile, the deterministic benchmark controls kept exposing what accuracy alone could hide

The unsafe control remains the strongest example:

```text
94.44% Ledger State Accuracy
100% Unsafe Mutation Rate
```

A single aggregate score would have described that agent as excellent.

Its actual behavior on the ambiguity case showed otherwise.

---

# The architecture that survived the experiments

The resulting design is deliberately less model-centric than the first version.

```text
                    ┌─────────────────────┐
                    │   Merchant message  │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Conversation state  │
                    │ + ledger context    │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Candidate retrieval │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Language interpreter│
                    └──────────┬──────────┘
                               │
                         Compact intent
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Deterministic       │
                    │ intent compiler     │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Ledger validation   │
                    └──────────┬──────────┘
                               │
                    safe       │       unsafe /
                    action     │       ambiguous
                      │        │          │
                      ▼        │          ▼
              ┌─────────────┐  │  ┌────────────────┐
              │ Apply event │  │  │ Ask / abstain  │
              └──────┬──────┘  │  └────────────────┘
                     │
                     ▼
              Persistent ledger
```

The model is still useful.

It simply no longer owns everything.

---

# Main Failure Mode

The most persistent failure across the experiments was **putting too much precision at the model boundary**.

A model could understand the merchant's sentence reasonably well and still fail because:

- the returned JSON was invalid
- the schema was slightly wrong
- a date was represented differently
- the provider failed
- the request was rate-limited
- a customer reference could not be safely resolved
- the model selected the wrong internal target

The eventual response was not to keep adding prompt instructions.

It was to change the system boundary.

Talli moved more work into deterministic components:

```text
date normalization
candidate retrieval
intent compilation
ledger validation
financial arithmetic
state projection
```

and kept the model focused on the part where flexible interpretation is genuinely useful.

---

# What I would not repeat

If I rebuilt Talli from the beginning, I would not start by asking the model to generate the application's richest internal financial schema.

It creates a misleading sense of simplicity:

```text
text → LLM → action
```

but moves too many failure modes into one opaque boundary.

I would begin much closer to the architecture Talli reached later:

```text
text
  ↓
small semantic intent
  ↓
deterministic resolution
  ↓
deterministic financial action
  ↓
validated state transition
```

I would also design provider failure as an expected runtime condition from the beginning rather than treating availability as something the application can assume.

---

# Hot Take

> **The hardest problem in conversational bookkeeping is not understanding what the user said. It is knowing whether you understand enough to safely change the ledger.**

A model that extracts `$50` correctly but applies it to the wrong Sarah has not succeeded.

A system that says *“I need you to clarify which Sarah you mean”* may look less intelligent in a demo, but for financial state it can be the much better agent.

That is why Talli's final design treats abstention, clarification and deterministic validation as core behavior rather than edge-case handling.

---

# Evidence Index

The claims in this log are backed by checked-in experiment artifacts, tests and trajectories.

| Evidence | Location |
| --- | --- |
| V1 baseline | `artifacts/experiments/baseline-v1.json` |
| V1 advanced | `artifacts/experiments/advanced-v1.json` |
| V2 baseline | `artifacts/experiments/baseline-v2.json` |
| V2 advanced | `artifacts/experiments/advanced-v2.json` |
| Contract smoke | `artifacts/experiments/contract-smoke.json` |
| Candidate-resolution smoke | `artifacts/experiments/resolution-smoke-*.json` |
| Resolution trajectories | `artifacts/trajectories/trajectory-resolution-smoke-*.json` |
| Perfect control | `artifacts/experiments/control-perfect-runtime.json` |
| Wrong control | `artifacts/experiments/control-wrong-runtime.json` |
| Unsafe control | `artifacts/experiments/control-unsafe-runtime.json` |
| Runtime trajectories | `artifacts/trajectories/trajectory-*-17_17_*.json` |
| Agent trajectories | `docs/AGENT_TRAJECTORIES.md` |

The evidence tells a less tidy story than a straight line from bad score to perfect score, but that is also the point of the project. Some changes improved the contract, some exposed the next bottleneck, and one promising architecture could not be fairly scored because the external provider failed.

The benchmark stayed fixed anyway.

That makes the improvement story reproducible rather than retrospective.