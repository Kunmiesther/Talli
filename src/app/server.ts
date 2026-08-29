import { createTalliHttpServer } from './api.js';
import { createTalliService } from './talli-service.js';

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
  const port = readPort();
  const server = createTalliHttpServer(service, port);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve());
  });

  console.log(`Talli API listening on http://127.0.0.1:${port}`);
  console.log(`Model available: ${service.interpreter ? 'yes' : 'no'}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
