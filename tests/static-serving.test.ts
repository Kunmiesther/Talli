import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('static frontend serving', () => {
  it('serves the Talli frontend and assets regardless of cwd', async () => {
    const originalCwd = process.cwd();
    const tempDir = await mkdtemp(join(tmpdir(), 'talli-static-'));

    process.chdir(tempDir);
    vi.resetModules();

    try {
      const [{ handleTalliApiRequest }, { createTalliService }] = await Promise.all([
        import('../src/app/api.js'),
        import('../src/app/talli-service.js'),
      ]);
      const service = createTalliService({ interpreter: null });

      const rootResponse = await handleTalliApiRequest(service, new Request('http://localhost/'));
      expect(rootResponse.status).toBe(200);
      expect(rootResponse.headers.get('content-type')).toContain('text/html');
      expect(await rootResponse.text()).toContain('Talli');

      const cssResponse = await handleTalliApiRequest(
        service,
        new Request('http://localhost/styles.css'),
      );
      expect(cssResponse.status).toBe(200);
      expect(cssResponse.headers.get('content-type')).toContain('text/css');

      const jsResponse = await handleTalliApiRequest(
        service,
        new Request('http://localhost/app.js'),
      );
      expect(jsResponse.status).toBe(200);
      expect(jsResponse.headers.get('content-type')).toContain('text/javascript');

      const assetResponse = await handleTalliApiRequest(
        service,
        new Request('http://localhost/assets/hero-merchant.jpg'),
      );
      expect(assetResponse.status).toBe(200);
      expect(assetResponse.headers.get('content-type')).toContain('image/jpeg');

      const healthResponse = await handleTalliApiRequest(
        service,
        new Request('http://localhost/api/health'),
      );
      expect(healthResponse.status).toBe(200);
      expect(healthResponse.headers.get('content-type')).toContain('application/json');
      expect(await healthResponse.json()).toMatchObject({ ok: true });

      const ledgerResponse = await handleTalliApiRequest(
        service,
        new Request('http://localhost/api/ledger'),
      );
      expect(ledgerResponse.status).toBe(200);
      expect(await ledgerResponse.json()).toMatchObject({
        customers: [],
        obligations: [],
      });

      const unknownApiResponse = await handleTalliApiRequest(
        service,
        new Request('http://localhost/api/unknown-route'),
      );
      expect(unknownApiResponse.status).toBe(404);
      expect(await unknownApiResponse.json()).toMatchObject({
        status: 'error',
        errorCode: 'NOT_FOUND',
      });
    } finally {
      process.chdir(originalCwd);
      vi.resetModules();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
