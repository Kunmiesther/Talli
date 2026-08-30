import { createTalliHttpServer } from './api.js';
import { createTalliService } from './talli-service.js';

function readHost(): string {
  return process.env.TALLI_HOST ?? process.env.HOST ?? '0.0.0.0';
}

function readPort(): number {
  const raw = process.env.TALLI_PORT ?? process.env.PORT ?? '3000';
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 3000;
  }
  return Math.trunc(parsed);
}

async function main() {
  const service = createTalliService();
  const host = readHost();
  const port = readPort();
  const server = createTalliHttpServer(service, port);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  console.log(`Talli API listening on ${host}:${port}`);
  console.log(`Model available: ${service.interpreter ? 'yes' : 'no'}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
