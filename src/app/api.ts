import { readFile } from 'node:fs/promises';
import { type IncomingMessage, type Server, createServer } from 'node:http';
import { extname, relative, resolve } from 'node:path';
import { URL } from 'node:url';
import type { TalliMessageInput, TalliService } from './talli-service.js';

export interface TalliApiResponse<T = unknown> {
  status: number;
  body: T;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text) as unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

const PUBLIC_DIR = resolve(process.cwd(), 'public');

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function contentTypeForPath(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

async function readStaticFile(filePath: string): Promise<Response | null> {
  try {
    const file = await readFile(filePath);
    return new Response(file, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': contentTypeForPath(filePath),
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function serveFrontendAsset(pathname: string): Promise<Response | null> {
  const normalized = pathname === '/' ? '/index.html' : pathname;
  const candidatePath = resolve(PUBLIC_DIR, `.${normalized}`);
  const relativePath = relative(PUBLIC_DIR, candidatePath);
  if (relativePath.startsWith('..') || relativePath.includes(':')) {
    return null;
  }

  const fileResponse = await readStaticFile(candidatePath);
  if (fileResponse) {
    return fileResponse;
  }

  if (normalized === '/index.html' || extname(normalized) === '') {
    return readStaticFile(resolve(PUBLIC_DIR, 'index.html'));
  }

  return null;
}

async function routeRequest(service: TalliService, request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'GET' || request.method === 'HEAD') {
    if (!url.pathname.startsWith('/api/')) {
      const staticResponse = await serveFrontendAsset(url.pathname);
      if (staticResponse) {
        return staticResponse;
      }
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    return jsonResponse(200, {
      ok: true,
      modelAvailable: Boolean(service.interpreter),
      provider: service.interpreter ? 'openai-compatible' : null,
      model: service.interpreter?.lastDiagnostics?.provider?.model ?? null,
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/ledger') {
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    return jsonResponse(200, await service.getLedger(sessionId));
  }

  if (request.method === 'GET' && url.pathname === '/api/customers') {
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    const ledger = await service.getLedger(sessionId);
    return jsonResponse(200, ledger.customers);
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/customers/')) {
    const customerId = decodeURIComponent(url.pathname.slice('/api/customers/'.length));
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    return jsonResponse(200, await service.getCustomerHistory(customerId, sessionId));
  }

  if (request.method === 'POST' && url.pathname === '/api/demo/reset') {
    const body = (await readJsonBody(request)) as { sessionId?: string };
    await service.resetDemoLedger(body.sessionId);
    return jsonResponse(200, { ok: true });
  }

  if (request.method === 'POST' && url.pathname === '/api/demo/seed') {
    const body = (await readJsonBody(request)) as { sessionId?: string };
    await service.seedDemoLedger(body.sessionId);
    return jsonResponse(200, { ok: true });
  }

  if (request.method === 'POST' && url.pathname === '/api/message') {
    let body: TalliMessageInput;
    try {
      body = (await readJsonBody(request)) as TalliMessageInput;
    } catch {
      return jsonResponse(400, {
        status: 'error',
        message: 'Invalid JSON payload.',
        action: null,
        ledgerChange: null,
        clarification: null,
        errorCode: 'BAD_REQUEST',
        modelAvailable: Boolean(service.interpreter),
      });
    }

    if (!body || typeof body.text !== 'string' || !body.text.trim()) {
      return jsonResponse(400, {
        status: 'error',
        message: 'A non-empty text field is required.',
        action: null,
        ledgerChange: null,
        clarification: null,
        errorCode: 'BAD_REQUEST',
        modelAvailable: Boolean(service.interpreter),
      });
    }

    const response = await service.processMessage(body);
    return jsonResponse(200, response);
  }

  return jsonResponse(404, {
    status: 'error',
    message: 'Not found.',
    action: null,
    ledgerChange: null,
    clarification: null,
    errorCode: 'NOT_FOUND',
    modelAvailable: Boolean(service.interpreter),
  });
}

export async function handleTalliApiRequest(
  service: TalliService,
  request: Request,
): Promise<Response> {
  try {
    return await routeRequest(service, request);
  } catch (error) {
    void error;
    return jsonResponse(500, {
      status: 'error',
      message: 'The ledger could not process that request safely.',
      action: null,
      ledgerChange: null,
      clarification: null,
      errorCode: 'INTERNAL_ERROR',
      modelAvailable: Boolean(service.interpreter),
    });
  }
}

export function createTalliHttpServer(service: TalliService, port: number): Server {
  return createServer(async (req: IncomingMessage, res) => {
    const method = req.method ?? 'GET';
    const host = req.headers.host ?? `127.0.0.1:${port}`;
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers.set(key, value);
      } else if (Array.isArray(value)) {
        headers.set(key, value.join(', '));
      }
    }

    const request = new Request(`http://${host}${req.url ?? '/'}`, {
      method,
      headers,
      body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
    });

    const response = await handleTalliApiRequest(service, request);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    const text = await response.text();
    res.end(text);
  });
}
