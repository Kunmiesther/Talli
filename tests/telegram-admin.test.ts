import { describe, expect, it, vi } from 'vitest';
import { TelegramBotApiTransport } from '../src/integrations/telegram/http-transport.js';
import { TELEGRAM_COMMAND_MENU } from '../src/integrations/telegram/run-webhook-admin.js';

describe('Telegram admin setup', () => {
  it('sends the expected setMyCommands payload', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as unknown,
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      });
    });

    const transport = new TelegramBotApiTransport(
      'bot-token',
      'https://api.telegram.org',
      fetchImpl as typeof fetch,
    );

    const result = await transport.setMyCommands(
      TELEGRAM_COMMAND_MENU.map((entry) => ({
        command: entry.command,
        description: entry.description,
      })),
    );

    expect(result).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.telegram.org/botbot-token/setMyCommands');
    expect(requests[0]?.body).toEqual({
      commands: [
        {
          command: 'start',
          description: 'Start Talli or connect your account',
        },
        {
          command: 'help',
          description: 'See how to use Talli',
        },
        {
          command: 'balance',
          description: 'View your outstanding credit summary',
        },
        {
          command: 'customers',
          description: 'View customers and their balances',
        },
      ],
    });
  });
});
