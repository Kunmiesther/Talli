import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OpenAICompatibleSpeechTranscriber,
  resolveConfiguredTranscriptionModel,
} from '../src/integrations/transcription/index.js';

describe('transcription provider configuration', () => {
  it('defaults Groq transcription to whisper-large-v3-turbo instead of whisper-1', () => {
    const model = resolveConfiguredTranscriptionModel({
      baseUrl: 'https://api.groq.com/openai/v1',
    });

    expect(model).toBe('whisper-large-v3-turbo');
    expect(model).not.toBe('whisper-1');
  });

  it('requires an explicit model for unknown OpenAI-compatible endpoints', () => {
    expect(() =>
      resolveConfiguredTranscriptionModel({
        baseUrl: 'https://openrouter.ai/api/v1',
      }),
    ).toThrow(/TRANSCRIPTION_MODEL/i);
  });

  it('posts multipart transcription requests to the configured base URL with the configured model', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'talli-transcription-'));
    const filePath = join(dataDir, 'voice-note.ogg');
    await writeFile(filePath, new Uint8Array([1, 2, 3]));

    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const transcriber = new OpenAICompatibleSpeechTranscriber({
      apiKey: 'test-key',
      model: 'whisper-large-v3-turbo',
      baseUrl: 'https://api.groq.com/openai/v1',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ text: 'Sarah owes 120 dollars' }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
      },
    });

    try {
      const transcript = await transcriber.transcribe({
        filePath,
        mimeType: 'audio/ogg',
      });

      expect(transcript).toBe('Sarah owes 120 dollars');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
      expect(calls[0]?.init?.method).toBe('POST');

      const body = calls[0]?.init?.body;
      expect(body).toBeInstanceOf(FormData);
      expect((body as FormData).get('model')).toBe('whisper-large-v3-turbo');
      expect((body as FormData).get('file')).not.toBeNull();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
