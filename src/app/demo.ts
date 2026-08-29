import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { type TalliMessageResponse, createTalliService } from './talli-service.js';

function isCommand(value: string): boolean {
  return value.startsWith(':');
}

function formatClarification(response: TalliMessageResponse): string {
  if (!response.clarification) {
    return response.message;
  }

  const candidates = response.clarification.candidates
    .map((candidate) => `${candidate.displayName}`)
    .join(', ');
  return candidates ? `${response.message}\nCandidates: ${candidates}` : response.message;
}

async function ensureSeeded(service: ReturnType<typeof createTalliService>): Promise<void> {
  const ledger = await service.getLedger();
  if (ledger.customers.length === 0 && ledger.obligations.length === 0) {
    await service.seedDemoLedger();
  }
}

async function runInteractive() {
  const service = createTalliService();
  await ensureSeeded(service);
  const rl = createInterface({ input, output });
  console.log('Talli demo. Type text or :quit to exit.');

  while (true) {
    const raw = await rl.question('You > ');
    const text = raw.trim();
    if (!text) {
      continue;
    }

    if (isCommand(text)) {
      if (text === ':quit' || text === ':exit') {
        break;
      }
      if (text === ':seed') {
        await service.seedDemoLedger();
        console.log('Talli > Demo ledger seeded.');
        continue;
      }
      if (text === ':reset') {
        await service.resetDemoLedger();
        await service.seedDemoLedger();
        console.log('Talli > Demo ledger reset.');
        continue;
      }
      if (text === ':ledger') {
        const ledger = await service.getLedger();
        console.log(
          `Talli > ${ledger.customers.length} customers, ${ledger.obligations.length} obligations.`,
        );
        continue;
      }
      console.log('Talli > Unknown command.');
      continue;
    }

    const response = await service.processMessage({ text });
    if (response.status === 'clarification_required') {
      console.log(`Talli > ${formatClarification(response)}`);
      continue;
    }

    console.log(`Talli > ${response.message}`);
  }

  rl.close();
}

async function runSeedOrReset(mode: 'seed' | 'reset'): Promise<void> {
  const service = createTalliService();
  if (mode === 'reset') {
    await service.resetDemoLedger();
  }
  await service.seedDemoLedger();
  const ledger = await service.getLedger();
  console.log(
    `Talli > Demo ledger ready: ${ledger.customers.length} customers, ${ledger.obligations.length} obligations.`,
  );
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'seed' || mode === 'reset') {
    await runSeedOrReset(mode);
    return;
  }

  await runInteractive();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
