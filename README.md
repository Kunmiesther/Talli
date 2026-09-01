# Talli

### Send a voice note. Talli keeps the ledger.

![TypeScript](https://img.shields.io/badge/TypeScript-234B6B?style=for-the-badge)
![Node.js](https://img.shields.io/badge/Node.js-23362B?style=for-the-badge)
![Telegram](https://img.shields.io/badge/Telegram-2A6F97?style=for-the-badge)
![Supabase](https://img.shields.io/badge/Supabase-0F5E54?style=for-the-badge)
![Groq](https://img.shields.io/badge/Groq-8B4A2B?style=for-the-badge)
![Vitest](https://img.shields.io/badge/Vitest-6B4E2E?style=for-the-badge)

**[Try Talli](https://talli.onrender.com)** ·

Talli is a voice-first credit assistant for small businesses. It lets a merchant record customer credit the same way they would normally explain it to another person: *“Sarah owes me 200 dollars,” “she paid 50 today,” “James will pay on Friday.”* Talli turns those conversations into a running ledger, so the merchant can see who owes them, how much has been paid, what is still outstanding and what happened previously without having to maintain the record by hand.

## Why I built Talli

For a lot of small businesses, giving a trusted customer something on credit is ordinary. Keeping track of that credit is where things can get messy.

A merchant might write *Sarah — $200* in a notebook today, add a $50 payment beside it three days later, then start another page for James, who says he will pay on Friday. That system works while the book is nearby and there are only a few things to remember. Once there are more customers, partial payments and old balances involved, it becomes surprisingly easy for the record to stop matching what actually happened.

The problem is not only that a notebook can be lost, damaged or have pages go missing. Even when the book is perfectly fine, finding an old entry and working out the current balance still takes time. Moving the same process into chat messages does not really solve it either because old updates eventually disappear into a long conversation.

There is bookkeeping software for this, of course, but that often means introducing another workflow: open the software, find the customer, create a transaction, choose the right fields, enter the amount, save it, then remember to do the same thing when the customer pays.

I wanted the interaction to be much simpler. If the merchant already knows how to say *“Sarah paid me 50 dollars today,”* why should recording it require anything more complicated than that?

> **What if keeping a proper credit record was as easy as sending a voice note?**

That became Talli.

## What using it actually looks like

Say a merchant gives Sarah $200 worth of goods on credit. Instead of opening a form, they can tell Talli:

```text
Sarah owes me 200 dollars.
```

Talli records the credit and Sarah now has an outstanding balance of $200. If she comes back later and pays part of it, the merchant can simply continue:

```text
Sarah paid me 50 dollars.
```

Talli finds Sarah's existing credit, records the payment and leaves $150 outstanding. When Sarah eventually pays the rest:

```text
Sarah has paid back the 150 dollars.
```

the balance is settled, but the original credit and both payments remain part of her history.

The same idea works when the update contains more than an amount. A merchant can say:

```text
James is owing 500 dollars and will pay on Friday.
```

and Talli records the credit together with the due date.

This works from the web app with text or browser voice input, and the same ledger can also be connected to Telegram. The Telegram integration accepts normal text and voice notes, so the merchant does not have to learn a completely different way of recording something just because they moved from one interface to another.

```mermaid
flowchart LR
    A[Merchant speaks or types] --> B[Web or Telegram]
    B --> C[Talli understands the update]
    C --> D[Checks the existing ledger]
    D --> E[Validates what should change]
    E --> F[Updates the ledger]
    F --> G[Balances and history stay in sync]
```

The web interface is useful when the merchant wants to look through customers, balances and history. Telegram is useful when they simply want to record something quickly. They are two ways into the same ledger rather than two separate products.

## The part that became harder than I expected

Voice transcription was not the difficult part of Talli. The harder problem appeared as soon as conversations started depending on things that had happened earlier.

Take these two messages:

```text
Monday:    Sarah owes me 200 dollars.
Thursday:  Sarah paid me 50 dollars.
```

The second message only makes sense because of the first one. Talli has to know that Sarah already has an open credit, recognise that $50 is a payment rather than another amount she owes, apply it to the right record and leave the correct balance behind.

Then the cases get less convenient. What if there are two customers named Sarah? What if Sarah has two open credits? What does *“she paid the remaining one”* refer to? Is *“make that 250”* a new debt or a correction to something the merchant just said?

Those are small sentences, but they can have very different effects on a financial record. That changed the problem I was solving from simple extraction into something more important: **how can an agent understand conversational updates over time without confidently changing the wrong financial state?**

The architecture that came out of that question deliberately separates language understanding from ledger authority. AI is useful for interpreting what the merchant means and using conversational context, but it does not get unrestricted control over the ledger. Talli validates the resulting action against the existing financial state before applying it, and common unambiguous statements also have a deterministic path so that every ordinary update does not have to depend on an external model call.

That separation matters most when Talli is uncertain. If two customers or two open credits could reasonably match a message, guessing is not a clever fallback. It is a way to corrupt the ledger.

> **When the financial state is unclear, Talli should ask rather than guess.**

## What is working today

The current build covers the full credit lifecycle I wanted for the first version: new customer credit, repeat credit, partial payments, full settlement, corrections, due dates, outstanding balances and customer history. It can use recent conversation and existing ledger context to resolve later updates, while ambiguous customers or obligations can be held for clarification instead of being changed blindly.

Voice and text are both supported on the web. Telegram account linking connects the merchant's Telegram identity to the same Talli user and ledger, and the local Telegram worker supports text messages, voice notes, `/balance`, `/customers`, `/help` and the linking flow. Voice notes are downloaded, transcribed and passed through the same Talli service as typed updates, so Telegram does not maintain a second version of the merchant's financial state.

For persistence, Talli can use local file storage during development or Supabase/PostgreSQL for user-scoped persistent state. Ledger events, conversation state, preferences and account links are kept separately so one merchant's records do not become another merchant's context.

Underneath that is an event-based ledger rather than a single balance that gets overwritten. A $200 credit followed by a $50 payment is still represented as the original credit and the later payment, while the current $150 balance is derived from that history. That makes corrections, payment history and state verification much easier to reason about.

## How I measured it

I did not want to evaluate Talli by recording a demo with three prompts I already knew would work. Before tuning the main agent paths, I locked a benchmark of **8 scenarios and 18 conversation turns**, together with the expected financial state after each turn. The cases include simple credit, partial and full payments, corrections, repeat customers, new obligations, references to earlier events, an ambiguity case where the correct behaviour is to abstain, and a Nigerian Pidgin stress case that came from an earlier multilingual product hypothesis.

The main metric is **Ledger State Accuracy (LSA)**. Rather than asking whether the model produced roughly the right sentence or action label, it checks whether the financially meaningful result is correct after the turn: customer, obligation, payment, outstanding balance, settlement status and due date where applicable.

I also track **Unsafe Mutation Rate (UMR)** because ordinary accuracy turned out not to tell the whole story. UMR looks specifically at the cases where the agent does not have enough information to safely act and asks whether it changed the ledger anyway.

That distinction produced one of the most useful results in the project. A deliberately unsafe control scored **94.44% Ledger State Accuracy**, which looks excellent in isolation, but it had **100% Unsafe Mutation Rate** on the ambiguity case. In other words, it got almost the entire benchmark right and still made the exact mistake I did not want a financial agent to make.

That experiment changed what I considered a "good" result. An agent that is correct most of the time but confidently edits the wrong customer's record when it is uncertain is not safe simply because its aggregate score is high.

> **For a financial agent, knowing when not to change the ledger can matter just as much as knowing what to change.**

## How Talli changed during development

The first model-backed version tried to go directly from a merchant's message to a large structured ledger action. It seemed convenient because the model could theoretically do everything in one step, but the live benchmark exposed how brittle that boundary was. Provider failures and schema-invalid outputs dominated the V1 runs, with both the baseline and advanced paths recording only **5.6% LSA** in those experiments.

For V2, I reduced the model's job. Instead of asking it to construct the complete financial mutation, the model produced a smaller intent that deterministic code could validate and compile into the richer ledger action. That gave the application a much cleaner boundary between understanding language and changing money-related state. It also made the remaining weakness easier to see: references to existing customers and obligations still needed better context.

V3 therefore moved candidate retrieval ahead of interpretation. Talli first narrows the customers and open obligations that could reasonably matter, then gives the interpreter that smaller context rather than expecting it to reason over everything. The implementation and tests were completed, but the intended live comparison hit external provider connection failures and rate limits, so I did not assign V3 a benchmark score that I could not actually measure.

The product itself continued moving after those experiments. Persistent sessions and an event-backed ledger made multi-turn use possible, deterministic parsing reduced unnecessary provider dependence for obvious statements, and Telegram turned the same runtime into something a merchant could use through an existing messaging app. Final manual testing also surfaced much less glamorous bugs that mattered just as much in practice: payment phrases such as *“paid back”*, debt phrasing such as *“is owing”*, date handling, binary image serving, shared web/Telegram state and account disconnect/reconnect. Those cases were fixed and added to regression coverage rather than treated as demo-only exceptions.

The full experiment history, including the evidence behind each change, is in **[IMPROVEMENT_LOG.md](./IMPROVEMENT_LOG.md)**.

### Main failure mode

The biggest failure mode was not that the model could not understand ordinary credit language. It was **giving the model too much responsibility for the final financial action**. Large structured outputs made provider behaviour, schema compliance and contextual resolution part of one fragile step.

The architecture became more dependable as those responsibilities were separated: the model handles the part that benefits from flexible language understanding, candidate retrieval narrows the relevant context, deterministic code compiles and validates the action, and the ledger remains the authority on whether a state transition is allowed.

External providers can still fail or rate-limit free-form interpretation, so that dependency has not magically disappeared. The difference is that the financial core no longer assumes that a successful model response is enough reason to mutate state.

### What didn't work, and what I kept from it

The rich-action approach was removed because asking for more structured output did not make the system more reliable. Provider chasing also stopped being useful once repeated live runs were being shaped more by free-tier availability and rate limits than by architecture. Candidate retrieval stayed because the implementation solved a real context problem even though the live V3 benchmark was inconclusive, while the unsafe control stayed in the evaluation because it exposed a weakness that aggregate accuracy would otherwise hide.

Those failed experiments ended up influencing Talli more than another successful demo prompt would have. They pushed the product toward smaller model responsibilities, explicit state validation and a much stronger definition of what "correct" means for a financial agent.

## Agent trajectories

The repository includes representative trajectories for the agents used during the project, with observable instructions, inputs, outputs, tool responses, retries and state changes where that evidence was preserved. It also documents the development-agent path from repository evidence without exposing or inventing private chain-of-thought.

**[View the agent trajectories](docs/AGENT_TRAJECTORIES.md)**

## Technical overview

Talli is written in TypeScript and runs on Node.js. Zod validates model-facing contracts and financial intents, Supabase/PostgreSQL provides persistent shared storage, and Vitest covers the ledger, runtime, integrations and evaluation logic. Telegram voice notes use an OpenAI-compatible transcription boundary, with Groq and `whisper-large-v3-turbo` used for the configured transcription path during development. The interpretation layer is also OpenAI-compatible, which keeps the application from being tied to one model provider.

```text
src/
├── app/                     Runtime service, API and storage
├── domain/                  Ledger, money and financial actions
├── integrations/
│   ├── telegram/            Linking, messages, commands and voice notes
│   └── transcription/       Voice transcription boundary
├── llm/                     Prompts, context, resolution and intent compilation
└── benchmark/               Locked evaluation and smoke harnesses

public/                      Web application
tests/                       Automated test suite
supabase/migrations/         Persistent database schema
artifacts/                   Saved benchmark evidence and trajectories
docs/AGENT_TRAJECTORIES.md   Representative agent traces
IMPROVEMENT_LOG.md           Development and experiment history
```

The main stack is **TypeScript, Node.js, Zod, Supabase/PostgreSQL, Telegram Bot API, Groq, OpenAI-compatible model APIs, Whisper Large V3 Turbo, Vitest, Biome, HTML/CSS/JavaScript and Render**.

## Reproduction Guide

The project can run with local file storage for development or Supabase when persistent shared state is required. A clean installation starts with:

```bash
git clone https://github.com/Kunmiesther/Talli.git
cd Talli
npm ci
```

Copy `.env.example` to `.env` and configure only the services you intend to use. The important environment groups are:

```env
# Interpretation
OPENAI_API_KEY=
OPENAI_BASE_URL=
OPENAI_MODEL=

# Voice transcription
TRANSCRIPTION_API_KEY=
TRANSCRIPTION_BASE_URL=
TRANSCRIPTION_MODEL=

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=UseTalliBot
TELEGRAM_WEBHOOK_SECRET=
TALLI_PUBLIC_URL=https://talli.onrender.com

# Persistent storage
TALLI_STORAGE_DRIVER=supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

# Runtime
SESSION_SECRET=
TALLI_TIMEZONE=
```

Real credentials should never be committed. For Supabase-backed persistence, apply the migration in `supabase/migrations/001_talli_core.sql` before starting the application. Without the Supabase storage driver, Talli can use its local file-backed development storage.

Start the web/API service with:

```bash
npm run dev:api
```

The default development URL is `http://localhost:3000`.

For the local Telegram integration, start the worker separately:

```bash
npm run dev:telegram
```

The web service and Telegram worker use the same configured storage, which is what allows both interfaces to operate on one merchant ledger.
Do not run polling and webhook delivery against the same bot at the same time.

For production webhook delivery on Render, register the webhook once after deployment:

```bash
npm run telegram:webhook:set
```

To inspect the current Telegram webhook status:

```bash
npm run telegram:webhook:info
```

### Tests and quality checks

Run the test suite with:

```bash
npm test
```

The repository also provides:

```bash
npm run typecheck
npm run lint
npm run build
```

Tests cover ledger operations, partial and full payments, corrections, due dates, ambiguity handling, shared web/Telegram state, user isolation, Telegram linking and voice notes, transcription configuration, static serving and safe provider failures.

### Reproducing the benchmark

The benchmark uses synthetic conversations and does not require private merchant data. The expected financial states are locked in the repository so the implementations can be compared against the same target.

For the baseline in PowerShell:

```powershell
$env:TALLI_INTERPRETER_MODE='baseline'
npm run benchmark
```

For Bash or Git Bash:

```bash
TALLI_INTERPRETER_MODE=baseline npm run benchmark
```

Run the advanced interpreter with:

```bash
TALLI_INTERPRETER_MODE=advanced npm run benchmark
```

The repository also contains benchmark controls and two focused smoke suites:

```bash
npm run smoke:contract
npm run smoke:resolution
```

Benchmark output includes the interpreter mode, scenario and turn counts, Ledger State Accuracy, Action Accuracy, abstention-required turns, unsafe mutations and Unsafe Mutation Rate. Saved experiment artifacts are kept under `artifacts/experiments/`, while sanitized trajectory evidence can be written to `artifacts/trajectories/`.

The live model benchmark and smoke suites can take several minutes depending on provider response time and rate limits. No fixed dollar reproduction cost is claimed because the development runs used provider-dependent/free-tier endpoints and cost changes with the configured model and token usage.

## Current limitations

Talli is currently a credit ledger, not a bank, payment processor or full accounting system. It only knows that a payment happened when the merchant tells it or an integration supplies that information, and it does not move money on a merchant's behalf.

The demonstrated product language is English, although the evaluation repository still contains a Nigerian Pidgin stress scenario from an earlier multilingual direction. Currency preferences are supported, but Talli does not perform FX conversion. WhatsApp and automatic debtor reminders are not implemented, and the verified Telegram development path currently uses the separate polling worker rather than pretending that the public web deployment also guarantees a continuously running Telegram worker.

Those limitations are deliberate boundaries around the current version rather than features hidden behind unfinished UI.

## Where Talli goes next

The next version of Talli should not become more complicated simply because more features are possible. The product is useful because recording credit can disappear into something the merchant already does naturally, so the first priority is to make that interaction available in more of the places where business already happens.

**WhatsApp is the obvious next interface**, alongside a production Telegram deployment that does not rely on a separately started local polling process. Voice should also become more tolerant of accents, noisy shops and additional languages so merchants are not forced to adapt the way they speak to the software. Reminders fit naturally into that workflow too, but they should be controlled by the merchant: Talli can remember that James promised to pay Friday without deciding on its own that James should be contacted.

Once the ledger has enough history, the more interesting opportunity is letting merchants use that history without turning Talli into traditional accounting software. Instead of digging through customer pages, they should be able to ask *“Who still owes me money?”*, *“What is overdue this week?”*, *“How much did customers pay back this month?”* or *“Show me Sarah's full history.”* Customer statements, overdue views, weekly or monthly summaries and exportable records all follow naturally from the financial state Talli is already maintaining.

Further out, optional payment integrations could let an incoming payment be reconciled against an open credit instead of requiring the merchant to report every payment manually. Accounting exports and other business integrations could then reuse the same ledger rather than asking the merchant to maintain the record again somewhere else.

The direction is not to make Talli an autonomous debt collector or another heavyweight business suite. It is to make the credit record increasingly useful while keeping the interaction that started the project intact:

> **Say what happened. Talli keeps the record.**

Built for the Micro1 Frontier Engineering Challenge.

**[Try Talli](https://talli.onrender.com)**
