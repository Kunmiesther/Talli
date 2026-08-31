# Talli Agent Trajectories

This document shows how the agents behind Talli move from an instruction or merchant message to an observable result.

It is not a collection of hidden reasoning or private chain-of-thought. Instead, it records the parts that can actually be inspected and reproduced: the instruction boundary, context supplied to the agent, model or tool output, compiled ledger action, state change, failure or retry, and the human feedback that shaped the next version.

The goal is to make one thing easy to answer:

> **What did the agent receive, what did it do, what happened next, and how did that evidence change Talli?**

---

## What counts as an agent in Talli?

Talli deliberately keeps the number of reasoning agents small.

The main runtime agents are:

| Agent | Responsibility |
| --- | --- |
| **Baseline Interpreter** | Interprets one merchant message with minimal context. Used as the technical baseline. |
| **Advanced Interpreter** | Interprets a merchant message using ledger state, recent conversation and resolution candidates. |
| **Codex Development Agent** | The coding agent used to implement and revise Talli during development. |
| **Benchmark Control Interpreters** | Perfect, deliberately wrong and deliberately unsafe agents used to verify that the evaluation itself behaves correctly. |

Several important parts of Talli are **not** agents:

- `parseExplicitLedgerIntent` is deterministic parsing.
- `compileLedgerIntent` is deterministic compilation and validation.
- `TalliService` coordinates the runtime.
- `applyLedgerAction` and the ledger projector enforce financial state.
- the speech transcriber is a tool.
- Telegram is an interface and transport.
- Supabase is persistence.
- the benchmark evaluator measures outcomes.

That distinction matters because Talli intentionally does **not** give every component model autonomy. Language interpretation is flexible; financial state changes are constrained.

---

# Agent Instructions

These files contain the main instruction and context boundaries used by the runtime agents:

- [`src/llm/prompts.ts`](../src/llm/prompts.ts) builds the baseline and advanced model instructions.
- [`src/llm/structured-action-model.ts`](../src/llm/structured-action-model.ts) sends OpenAI-compatible requests and records provider failures, retries, parse failures and schema failures.
- [`src/llm/context.ts`](../src/llm/context.ts) builds the context package used by the advanced interpreter.
- [`src/llm/resolution-candidates.ts`](../src/llm/resolution-candidates.ts) narrows the customers and obligations that may be relevant to the current message.
- [`src/llm/intent-compiler.ts`](../src/llm/intent-compiler.ts) compiles interpreted intent into a ledger action that can be validated.
- [`src/app/explicit-intent.ts`](../src/app/explicit-intent.ts) handles obvious financial statements deterministically before the model path is needed.
- [`src/integrations/telegram/telegram-service.ts`](../src/integrations/telegram/telegram-service.ts) sends Telegram text and transcribed voice notes through the same Talli runtime.

The speech transcriber participates in a trajectory as a tool, but it is not treated as a reasoning agent.

---

# 1. Development Agent: Codex

Codex was the coding agent used throughout Talli's development.

Its job changed over time because the evidence changed. Early instructions focused on getting a stateful ledger agent working. Later instructions became increasingly specific around provider failure, ambiguity, deterministic safeguards, Telegram integration and regressions discovered during real product testing.

The complete historical Codex conversations were not stored in this repository, and private Codex chain-of-thought is neither reproduced nor reconstructed here.

The trajectory below is therefore reconstructed only from observable evidence that remains in the project:

- source changes
- benchmark artifacts
- tests
- the improvement log
- commit history
- runtime behavior

No missing model outputs or private reasoning have been invented.

## Representative Codex Development Trajectory

### Step 1: Lock the evaluation before tuning the agent

**Human checkpoint**

The benchmark had to be fixed before model tuning so a bad result could not be hidden by changing the expected answer afterwards.

**Codex action**

Codex implemented the benchmark scenarios, fixed reference time and evaluator around 8 scenarios and 18 conversation turns.

Relevant code:

```text
src/benchmark/scenarios.ts
src/benchmark/evaluator.ts
```

**Tool feedback**

The benchmark controls reproduced known expected outcomes, giving the project a stable measurement boundary.

**Result**

Every later interpreter experiment had to face the same ground truth.

This became the foundation for the rest of the development process.

---

### Step 2: Let the model produce the complete ledger action

**Human instruction**

Start with a direct structured-action architecture and measure whether the model can turn a merchant message into the final financial action.

**Codex action**

Codex built the OpenAI-compatible structured response layer and the first rich ledger-action contract.

Relevant implementation:

```text
src/llm/structured-action-model.ts
```

**Observed feedback**

The saved V1 benchmark artifacts showed that the approach was extremely brittle in live use.

```text
artifacts/experiments/baseline-v1.json
artifacts/experiments/advanced-v1.json
```

The runs recorded heavy provider and schema failures. The development log records both V1 paths at **5.6% Ledger State Accuracy**, with provider failures dominating most turns.

**Human checkpoint**

The issue was no longer simply "make the prompt better."

The model was being asked to produce too much financially meaningful structure in one step.

**Result**

The rich action contract stopped being the preferred architecture.

---

### Step 3: Reduce what the model is responsible for

**Human instruction**

The model should understand the merchant, but deterministic code should own more of the final financial action.

**Codex action**

Codex introduced a compact intent representation and a deterministic intent compiler.

Relevant implementation:

```text
src/llm/intent.ts
src/llm/intent-compiler.ts
```

Instead of asking the model to construct the final rich ledger mutation, the model could return a smaller description of what it believed the merchant meant.

The compiler then turned that interpretation into the richer action understood by the ledger.

**Tool feedback**

The compact contract passed the focused contract smoke suite and reduced schema brittleness compared with V1.

The saved V2 experiment artifacts and `IMPROVEMENT_LOG.md` record the measured comparison.

**Human checkpoint**

The architecture was now easier to validate, but contextual references were still weak. Phrases that depended on an existing customer or obligation needed better context than a generic conversation dump.

**Result**

Talli kept the compact intent architecture and moved next to explicit resolution support.

---

### Step 4: Retrieve likely customers and obligations before interpretation

**Human instruction**

Do not make the model search the entire financial history implicitly. Give it a small, relevant candidate set.

**Codex action**

Codex introduced candidate retrieval and candidate-centered context.

Relevant implementation:

```text
src/llm/resolution-candidates.ts
src/llm/context.ts
src/benchmark/resolution-smoke.ts
```

The advanced path could now receive:

- likely customers
- likely open obligations
- recent turns
- stable IDs
- selection notes
- temporal context

**Tool feedback**

The deterministic parts of candidate construction were covered by tests, but live provider runs became unreliable.

The development evidence records:

```text
Groq: fetch failed
OpenRouter: 429 rate limit
```

Meanwhile the benchmark controls remained healthy:

```text
Perfect control: 100% LSA
Wrong control:   5.6% LSA
Unsafe control:  94.44% LSA
```

**Human checkpoint**

Provider failure was now distorting the experiment more than another prompt iteration would help.

The decision was made not to invent a V3 win simply because the architecture looked better.

**Result**

Candidate retrieval stayed in the system because it solved a real context problem, but no unsupported final V3 benchmark score was claimed.

---

### Step 5: Stop calling a model for statements that do not need one

**Human instruction**

A statement like:

```text
Sarah owes me 200 dollars.
```

should not become impossible to record just because an external model endpoint is unavailable.

**Codex action**

Codex added deterministic explicit parsing for obvious ledger statements.

Relevant implementation:

```text
src/app/explicit-intent.ts
```

**Tool feedback**

Runtime tests covered direct creation, partial payment, settlement and correction behavior without requiring a model call.

**Human checkpoint**

The model should be used where flexible language understanding is valuable, not as a mandatory dependency for every simple financial statement.

**Result**

Talli gained a deterministic path for common merchant updates while preserving the model-backed path for more contextual language.

---

### Step 6: Turn Telegram into another interface to the same ledger

**Human instruction**

Telegram should not create a second product or separate record. A merchant should be able to update Talli from Telegram and see the same state on the web.

**Codex action**

Codex implemented:

- Telegram account linking
- shared user identity
- text-message ingestion
- `/balance`
- `/customers`
- `/help`
- voice-note ingestion
- shared persistence across web and Telegram

Relevant implementation:

```text
src/integrations/telegram/
src/app/storage.ts
supabase/migrations/001_talli_core.sql
```

**Tool feedback**

The shared-state and Telegram tests verified that both surfaces could reach the same ledger while preserving user isolation.

```text
tests/shared-state.test.ts
tests/telegram-voice.test.ts
```

**Human checkpoint**

The product now behaved like one ledger with multiple interfaces instead of a web demo plus an unrelated bot.

**Result**

Telegram became a real Talli entry point rather than a mock integration.

---

### Step 7: Add real voice-note ingestion

**Human instruction**

A voice-first product should accept an actual Telegram voice note, not merely simulate voice with typed text.

**Codex action**

The Telegram worker was connected to the speech-transcription boundary.

The flow became:

```text
Telegram voice note
        ↓
Telegram getFile
        ↓
download temporary audio
        ↓
speech transcription
        ↓
TalliService.processMessage
        ↓
same ledger used by text/web
        ↓
Telegram confirmation
```

**Tool feedback**

`tests/telegram-voice.test.ts` verified successful ingestion as well as cleanup and safe failure behavior.

If download or transcription fails, the message does not become a speculative ledger action.

**Result**

Voice became an actual input path into the same credit ledger.

---

### Step 8: Real product testing found less glamorous bugs

The final development stage was driven less by architecture diagrams and more by actually trying to use Talli.

**Human checkpoints included:**

```text
Sarah owes 200 dollars
Sarah has paid back the $200
James is owing 500 dollars and will pay on Friday
```

Those interactions exposed problems that benchmark architecture alone had not caught:

- customer-name regexes captured auxiliary words
- `paid back`, `paid off`, `repaid`, `settled` and `cleared` needed better payment handling
- `is owing` needed to be recognized as credit language
- Friday due-date handling needed verification
- static image bytes were being corrupted by a response bridge
- Telegram unlink/reconnect needed a complete lifecycle
- duplicate names and multiple open obligations needed regression coverage

**Codex action**

Codex fixed the runtime regressions and added tests around them.

Relevant evidence includes commits:

```text
83144ae
3e7593c
0486629
```

and the current runtime tests.

**Result**

The final stage of Talli development was not another model rewrite. It was making the system hold up under the ordinary phrases and product flows that a real merchant would actually use.

---

# 2. Baseline Interpreter Trajectory

The Baseline Interpreter exists so Talli has a meaningful technical comparison.

It receives the current utterance and basic temporal information, but it does **not** receive the richer persistent customer and obligation context available to the advanced path.

## Instruction boundary

```text
buildBaselineSystemPrompt
buildBaselineUserPrompt
BaselineInterpreter
```

Relevant file:

[`src/llm/prompts.ts`](../src/llm/prompts.ts)

## Representative input

```text
Amina took 35k goods today.
```

## Context visible to the agent

The tests show that the baseline request contains:

```text
current utterance
reference clock
language
```

It intentionally does not receive:

```text
customer candidate set
obligation candidate set
ledger history
rich recent-turn context
```

## Observable result

The provider output is captured and validated against the model contract before it can become a ledger action.

If the provider output is invalid, the baseline path does not simply invent the missing structure.

## Why this trajectory matters

The baseline is intentionally weaker because the project is trying to measure a specific question:

> Does persistent state and targeted context actually help a conversational ledger agent?

Without a constrained baseline, there would be no meaningful technical comparison.

Evidence:

```text
tests/llm.test.ts
artifacts/experiments/baseline-v1.json
artifacts/experiments/baseline-v2.json
```

---

# 3. Advanced Interpreter Trajectory

The Advanced Interpreter handles the state-aware version of Talli.

Instead of treating every merchant message as an isolated statement, it receives a compact package describing what may already matter to the current turn.

## Instruction boundary

```text
buildAdvancedSystemPrompt
buildAdvancedUserPrompt
buildAdvancedContextPackage
AdvancedInterpreter
```

Relevant files:

```text
src/llm/prompts.ts
src/llm/context.ts
src/llm/resolution-candidates.ts
src/interpreters.ts
```

## Representative input

```text
Mama Tobi don bring 20k from that money.
```

This example came from the earlier multilingual/Pidgin evaluation hypothesis.

The important difficulty is not extracting `20k`. It is resolving what **"that money"** refers to.

## Context supplied to the advanced agent

The advanced request may contain:

```text
customerCandidates
obligationCandidates
recentTurns
selectionNotes
reference time
existing ledger snapshot
```

Stable record IDs are supplied where available so the model can refer to an existing object instead of recreating it by name.

## Observable behavior

The advanced agent can return a compact intent describing a payment or reference resolution.

That intent still does not directly mutate the ledger.

It must pass through the deterministic compiler.

```text
Advanced Interpreter
        ↓
compact LedgerIntent
        ↓
compileLedgerIntent
        ↓
validated LedgerAction
        ↓
TalliService
        ↓
ledger rules
```

If the target cannot be resolved safely, `request_clarification` remains a valid outcome.

## Result

The advanced agent gets more contextual information than the baseline, but more context does not mean more permission.

The financial state still has the final say.

Evidence:

```text
tests/llm.test.ts
tests/resolution-candidates.test.ts
src/llm/context.ts
src/llm/intent-compiler.ts
```

---

# 4. End-to-End State-Aware Payment

This trajectory shows how the different pieces connect in a normal merchant interaction.

## Existing ledger

```text
Customer: Sarah
Original credit: $200
Outstanding balance: $200
Status: Open
```

## Merchant message

```text
Sarah paid $50.
```

## Resolution

Talli can identify:

```text
Customer candidate:
Sarah

Open obligation candidate:
$200 credit
```

If the context is unambiguous, the message is interpreted as a payment against that obligation.

## Interpreted intent

Conceptually:

```text
type: payment
customer: Sarah
amount: $50
target: existing open obligation
```

## Compiled financial action

The deterministic compiler resolves that intent into the ledger action accepted by the domain layer.

## State transition

Before:

```text
Sarah outstanding: $200
Payments: $0
Status: Open
```

After:

```text
Payment recorded: $50
Sarah outstanding: $150
Status: Open
```

The original $200 credit remains in history rather than being replaced by `$150`.

## Safety branch

If two different Sarah records could match, or Sarah had several obligations that made the target genuinely unclear, Talli should not apply the payment.

The safe outcome becomes clarification.

This is the difference between conversational understanding and ledger authority.

Evidence:

```text
tests/app-runtime.test.ts
src/llm/intent-compiler.ts
src/domain/ledger.ts
src/app/talli-service.ts
```

---

# 5. Deterministic Explicit Parser Trajectory

Not every merchant message needs an LLM.

For obvious statements, Talli tries deterministic interpretation first.

## Instruction boundary

```text
parseExplicitLedgerIntent
```

Relevant file:

[`src/app/explicit-intent.ts`](../src/app/explicit-intent.ts)

## Example conversation

```text
Bisi owes 5k.
```

Later:

```text
Bisi paid 2k.
```

Then:

```text
Actually Bisi owes 4k, not 5k.
```

## Observable behavior

The explicit parser can recognize common financial structures such as:

- customer name
- amount
- payment language
- credit language
- explicit currency
- correction language
- common due-date phrases

For those obvious statements, the model path does not need to be called.

## Result

Talli can still process common ledger actions when an external model endpoint is unavailable.

This was a direct response to provider failures observed during earlier experiments.

Evidence:

```text
src/app/explicit-intent.ts
tests/app-runtime.test.ts
```

---

# 6. Ambiguity and Abstention Trajectory

This is the trajectory that matters most to Talli's safety story.

Consider:

```text
Sarah paid $50.
```

That looks trivial until the merchant has two customers named Sarah.

Or consider:

```text
Musa paid 10k.
```

when Musa has more than one open obligation and the message gives no way to decide which one should receive the payment.

## Instruction boundary

```text
compileLedgerIntent
TalliService.processMessage
applyLedgerAction
```

## Unsafe behavior would be

```text
pick one plausible record
        ↓
apply $50 payment
        ↓
return confident confirmation
```

The interface would look successful while the ledger could now be wrong.

## Talli's intended behavior

```text
detect multiple plausible targets
        ↓
do not choose one silently
        ↓
leave ledger unchanged
        ↓
request clarification
```

## Observable feedback

`tests/app-runtime.test.ts` and `tests/ledger.test.ts` cover cases where duplicate names or unclear obligations must remain unresolved.

The benchmark also contains a deliberately unsafe control that takes the opposite approach.

That unsafe control scored:

```text
Ledger State Accuracy: 94.44%
Unsafe Mutation Rate:   100%
```

on the ambiguity-required set.

The control is intentionally wrong, but its high overall accuracy demonstrates why this trajectory exists at all.

A financial agent can look excellent on aggregate while making the most dangerous decision in the benchmark.

## Result

Talli treats abstention as successful behavior when acting would require a guess.

Evidence:

```text
tests/app-runtime.test.ts
tests/ledger.test.ts
artifacts/experiments/control-unsafe-runtime.json
```

---

# 7. Provider Failure and Retry Trajectory

External model providers do not always return clean structured output.

Talli's early experiments encountered:

- invalid JSON
- schema-invalid output
- request failures
- fetch failures
- rate limits

## Instruction boundary

```text
OpenAICompatibleStructuredActionModel
```

Relevant file:

[`src/llm/structured-action-model.ts`](../src/llm/structured-action-model.ts)

## Failure path

A provider request is sent.

If the output is malformed or fails the required contract, the structured-action layer records diagnostics and uses bounded retry behavior rather than accepting arbitrary output.

Conceptually:

```text
provider request
      ↓
malformed result
      ↓
parse / schema failure
      ↓
bounded retry when applicable
      ↓
still invalid
      ↓
safe failure / clarification
```

## Observable feedback

`tests/llm.test.ts` covers malformed output and bounded retry behavior.

The early V1 artifacts record how severe this problem became under live conditions.

```text
artifacts/experiments/baseline-v1.json
artifacts/experiments/advanced-v1.json
```

Diagnostics include information such as:

```text
provider failure
parse failure
schema failure
retry metadata
request metadata
```

## Result

Provider failure is treated as a reason **not** to mutate the ledger, not as permission to guess what the provider probably meant.

That failure path later influenced the move toward smaller model intents and deterministic handling for obvious statements.

---

# 8. Telegram Voice-Note Trajectory

A voice-first ledger needs more than a microphone icon.

The Telegram path handles an actual voice note from message receipt to ledger update.

## Instruction boundary

```text
TelegramConversationService
OpenAICompatibleSpeechTranscriber
TalliService.processMessage
```

## Merchant action

A linked merchant sends a Telegram voice note.

## Observable tool path

```text
Telegram message received
        ↓
Telegram file metadata requested
        ↓
audio downloaded
        ↓
temporary file created
        ↓
speech transcriber called
        ↓
transcribed text returned
        ↓
TalliService.processMessage
        ↓
ledger action processed
        ↓
Telegram response sent
        ↓
temporary file removed
```

The transcription service is a tool in this trajectory, not an independent reasoning agent.

## Failure checkpoints

If the user has not linked their account:

```text
No ledger mutation
→ user is asked to connect Telegram
```

If Telegram file download fails:

```text
No ledger mutation
→ safe error response
```

If transcription fails:

```text
No ledger mutation
→ safe error response
```

Only successfully transcribed text reaches the same conversational ledger runtime used elsewhere in Talli.

## Result

Voice notes and ordinary typed messages converge on the same financial state instead of creating separate logic for each interface.

Evidence:

```text
tests/telegram-voice.test.ts
src/integrations/telegram/telegram-service.ts
src/integrations/transcription/speech-transcriber.ts
```

---

# 9. Web and Telegram Shared-State Trajectory

A merchant may record something quickly in Telegram and later inspect the ledger from the web.

Those surfaces therefore have to agree.

## Starting state

```text
Talli user: Merchant A
Ledger balance: $0
Telegram account: linked
```

## Telegram action

```text
Sarah owes me 200 dollars.
```

The Telegram message is processed through the merchant's Talli user scope.

## Persisted result

```text
Sarah
Outstanding: $200
```

## Web action

The same merchant opens the web ledger using their linked Talli session.

## Expected result

The web application sees the same Sarah record and the same $200 balance.

No migration or duplicated bot-specific ledger is required.

## User-isolation checkpoint

Merchant B must not see Merchant A's Sarah record even if both happen to have customers with the same name.

## Result

Telegram and the web are interfaces to the same scoped financial state.

Evidence:

```text
tests/shared-state.test.ts
supabase/migrations/001_talli_core.sql
src/app/storage.ts
```

---

# 10. Resolution Smoke and Upstream Failure

Candidate retrieval was introduced to improve contextual references, but the corresponding live experiment also produced an important failure trajectory.

## Inputs

The resolution smoke suite includes cases around:

- partial payments
- previous references
- corrections
- ambiguity
- multilingual/Pidgin updates

## Observable trajectory evidence

When trajectory output is enabled, the smoke runner records sanitized data including:

```text
candidate package
model intent
compiled action
provider diagnostics
before snapshot
after snapshot
```

under:

```text
artifacts/trajectories/
```

## Tool feedback

During live attempts, external providers returned failures including:

```text
Groq fetch failure
OpenRouter 429
```

## Human checkpoint

The implementation existed, but the external conditions did not support a trustworthy final live comparison.

The correct response was not to keep rerunning providers until a flattering number appeared.

## Result

V3 candidate retrieval remains part of the implemented architecture, while its live benchmark improvement is explicitly left unclaimed.

That is a failure trajectory, but it is also part of the reproducibility story.

Evidence:

```text
src/benchmark/resolution-smoke.ts
artifacts/trajectories/
IMPROVEMENT_LOG.md
```

---

# 11. Benchmark Control Agents

Talli includes three deliberately artificial interpreters whose job is to test the evaluator itself.

They are not product agents.

## PerfectFixtureInterpreter

The perfect control emits the expected benchmark behavior.

Expected outcome:

```text
LSA: 100%
Action Accuracy: 100%
UMR: 0%
```

Its purpose is to prove that the evaluator can award a perfect score when given the expected behavior.

---

## IntentionallyWrongInterpreter

The wrong control intentionally performs badly.

Its purpose is to make sure an obviously incorrect implementation does not accidentally score well because of an evaluator bug.

Observed benchmark behavior includes:

```text
LSA: 5.6%
Action Accuracy: 0%
UMR: 0%
```

---

## UnsafeMutationInterpreter

The unsafe control is the most informative one.

It behaves correctly on most ordinary turns but deliberately mutates state where the correct behavior is abstention.

Observed result:

```text
LSA: 94.44%
Action Accuracy: 94.44%
UMR: 100%
```

That control demonstrates a weakness that would be invisible if Talli were judged only by overall accuracy.

> A system can be right almost all the time and still be unsafe at the one moment where uncertainty matters.

The control agents are implemented in:

```text
src/benchmark/control-interpreters.ts
```

with saved evidence under:

```text
artifacts/experiments/control-perfect-runtime.json
artifacts/experiments/control-wrong-runtime.json
artifacts/experiments/control-unsafe-runtime.json
```

---

# How the trajectories changed the architecture

Taken together, the trajectories tell a fairly simple development story.

The first version gave the model a large job and discovered that structured-output reliability was too fragile. The next version reduced the model to a smaller intent contract. Contextual references then exposed the need for deterministic candidate retrieval, while provider failures showed that obvious statements should not always require an external model at all.

Once the core ledger behavior became more dependable, product integration uncovered a different class of failures: voice ingestion, shared state, account lifecycle, language variants, due dates and ordinary merchant phrasing.

Finally, the unsafe benchmark control showed that aggregate accuracy by itself was not enough to define success.

That progression produced the boundary Talli uses now:

```text
human language
      ↓
deterministic parsing when obvious
      ↓
state-aware interpretation when needed
      ↓
candidate resolution
      ↓
compact intent
      ↓
deterministic compilation
      ↓
ledger validation
      ↓
persistent state
```

The model helps interpret what the merchant means.

It does not get the final word on whether the ledger should change.

---

# Human Checkpoints That Changed Talli

Human feedback was not reserved for the end of the project. It repeatedly changed the implementation.

| Checkpoint | Evidence observed | What changed |
| --- | --- | --- |
| The benchmark must not move after evaluation starts | Early measurement needed a stable target | Ground truth was locked first |
| Rich structured output was failing too often | Provider and schema failures in V1 | Model responsibility was reduced |
| Contextual references were still weak | Resolution smoke cases | Candidate retrieval was added |
| Providers were becoming the bottleneck | Fetch failures and 429 responses | Provider chasing stopped and deterministic paths became more important |
| Web and Telegram must not maintain separate records | Shared-state testing | Both surfaces were routed to the same ledger |
| Voice has to be real, not decorative | Telegram voice workflow | Actual download/transcribe/process path was implemented |
| `paid back` and `is owing` should work naturally | Manual product testing | Explicit parser coverage expanded |
| Duplicate customers must not be guessed | Runtime ambiguity testing | Clarification remained a first-class outcome |
| Account linking needs a complete lifecycle | Disconnect/reconnect testing | Telegram unlink and reconnect support was added |

These checkpoints are summarized from observable implementation and test evidence. They are not presented as verbatim transcripts of historical conversations.

---

# Evidence Index

For reviewers who want to inspect the implementation rather than read every trajectory sequentially:

| What you want to inspect | Start here |
| --- | --- |
| Runtime ledger behavior | `tests/app-runtime.test.ts` |
| Baseline vs advanced model boundaries | `tests/llm.test.ts` |
| Candidate retrieval | `tests/resolution-candidates.test.ts` |
| Ledger safety rules | `tests/ledger.test.ts` |
| Telegram/web shared state | `tests/shared-state.test.ts` |
| Telegram voice ingestion | `tests/telegram-voice.test.ts` |
| Provider and transcription separation | `tests/transcription-provider.test.ts` |
| V1 provider/schema failures | `artifacts/experiments/baseline-v1.json`, `advanced-v1.json` |
| Unsafe-control result | `artifacts/experiments/control-unsafe-runtime.json` |
| Sanitized runtime trajectories | `artifacts/trajectories/` |
| Development decisions | `IMPROVEMENT_LOG.md` |

---

# The trajectory that matters most

The most important Talli trajectory is not a successful `$200` credit entry.

It is this one:

```text
Merchant says something ambiguous
        ↓
Talli finds multiple plausible financial targets
        ↓
The agent does not know enough to choose safely
        ↓
No ledger mutation is applied
        ↓
The merchant is asked to clarify
```

That can look less impressive in a demo than a confident instant answer.

For a financial ledger, it is the better result.

The project began as a way to turn conversational credit updates into structured records. The trajectories above are what pushed it toward a stricter idea:

> **Understanding the merchant is only half the job. Talli also has to know when it does not understand enough to safely change the ledger.**