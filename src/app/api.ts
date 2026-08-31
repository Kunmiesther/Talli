import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { type IncomingMessage, type Server, createServer } from 'node:http';
import { dirname, extname, relative, resolve } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
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

function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(';')) {
    const [rawKey, ...rawValueParts] = part.trim().split('=');
    if (!rawKey || rawValueParts.length === 0) {
      continue;
    }
    cookies.set(rawKey, decodeURIComponent(rawValueParts.join('=')));
  }
  return cookies;
}

function serializeCookie(options: {
  name: string;
  value: string;
  httpOnly?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  secure?: boolean;
  maxAgeSeconds?: number;
  path?: string;
}): string {
  const parts = [`${options.name}=${encodeURIComponent(options.value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.trunc(options.maxAgeSeconds))}`);
  }
  if (options.httpOnly !== false) {
    parts.push('HttpOnly');
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function isSecureRequest(request: Request): boolean {
  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto?.toLowerCase() === 'https') {
    return true;
  }
  return new URL(request.url).protocol === 'https:';
}

function normalizeTelegramUsername(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/^@+/, '');
}

async function resolveSessionId(service: TalliService, request: Request): Promise<string> {
  const url = new URL(request.url);
  const querySessionId = url.searchParams.get('sessionId') ?? null;
  if (querySessionId) {
    return querySessionId;
  }

  const cookies = parseCookies(request.headers.get('cookie'));
  const webSessionToken = cookies.get('talli_session');
  if (webSessionToken) {
    const resolved = await service.store.resolveWebSession(webSessionToken);
    if (resolved) {
      return resolved;
    }
  }

  return service.store.defaultSessionId;
}

function findProjectRoot(startDir: string): string {
  let currentDir = startDir;
  while (true) {
    if (
      existsSync(resolve(currentDir, 'package.json')) &&
      existsSync(resolve(currentDir, 'public', 'index.html'))
    ) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return process.cwd();
    }
    currentDir = parentDir;
  }
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(findProjectRoot(MODULE_DIR), 'public');

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

  if (request.method === 'GET' && url.pathname === '/api/me') {
    const sessionId = await resolveSessionId(service, request);
    const current = await service.getCurrentUser(sessionId);
    return jsonResponse(200, {
      ok: true,
      connected: current.connected,
      userId: current.userId,
      telegramUserId: current.telegramUserId,
      telegramUsername: current.telegramUsername,
      preferredCurrency: current.preferredCurrency,
      ledgerCurrency: current.ledgerCurrency,
      sessionId: current.sessionId,
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/ledger') {
    const sessionId = await resolveSessionId(service, request);
    return jsonResponse(200, await service.getLedger(sessionId));
  }

  if (request.method === 'GET' && url.pathname === '/api/customers') {
    const sessionId = await resolveSessionId(service, request);
    const ledger = await service.getLedger(sessionId);
    return jsonResponse(200, ledger.customers);
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/customers/')) {
    const customerId = decodeURIComponent(url.pathname.slice('/api/customers/'.length));
    const sessionId = await resolveSessionId(service, request);
    return jsonResponse(200, await service.getCustomerHistory(customerId, sessionId));
  }

  if (request.method === 'POST' && url.pathname === '/api/preferences/currency') {
    const body = (await readJsonBody(request)) as { currency?: string };
    const sessionId = await resolveSessionId(service, request);
    if (typeof body.currency !== 'string' || !body.currency.trim()) {
      return jsonResponse(400, {
        status: 'error',
        message: 'A currency code is required.',
        errorCode: 'BAD_REQUEST',
      });
    }
    await service.setPreferredCurrency(sessionId, body.currency.trim().toUpperCase());
    return jsonResponse(200, {
      ok: true,
      sessionId,
      preferredCurrency: body.currency.trim().toUpperCase(),
    });
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/telegram/link-token') {
    const token = await service.createTelegramLinkToken();
    const botUsername = normalizeTelegramUsername(process.env.TELEGRAM_BOT_USERNAME);
    const deepLink = botUsername
      ? `https://t.me/${botUsername}?start=link_${token.token}`
      : `https://t.me/?start=link_${token.token}`;
    return jsonResponse(200, {
      ok: true,
      linkToken: token.token,
      expiresAt: token.expiresAt,
      deepLink,
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/auth/telegram/link-status') {
    const token = url.searchParams.get('token');
    if (!token) {
      return jsonResponse(400, {
        ok: false,
        status: 'missing_token',
      });
    }
    const linkToken = await service.getTelegramLinkToken(token);
    if (!linkToken) {
      return jsonResponse(404, {
        ok: false,
        status: 'not_found',
      });
    }
    const connected = Boolean(linkToken.consumedAt && linkToken.webSessionToken);
    const response = jsonResponse(200, {
      ok: true,
      status: connected ? 'connected' : 'pending',
      connected,
      userId: linkToken.userId,
      expiresAt: linkToken.expiresAt,
    });
    if (connected && linkToken.webSessionToken) {
      response.headers.set(
        'Set-Cookie',
        serializeCookie({
          name: 'talli_session',
          value: linkToken.webSessionToken,
          httpOnly: true,
          sameSite: 'Lax',
          secure: isSecureRequest(request),
          maxAgeSeconds: 30 * 24 * 60 * 60,
        }),
      );
    }
    return response;
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

    const sessionId = body.sessionId ?? (await resolveSessionId(service, request));
    const response = await service.processMessage({
      ...body,
      sessionId,
      origin: 'web',
    });
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
