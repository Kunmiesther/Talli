import type { SpeechTranscriber, SpeechTranscriptionInput } from './speech-transcriber.js';

export class MockSpeechTranscriber implements SpeechTranscriber {
  readonly calls: SpeechTranscriptionInput[] = [];

  constructor(
    private readonly handler: (input: SpeechTranscriptionInput) => string | Promise<string>,
  ) {}

  async transcribe(input: SpeechTranscriptionInput): Promise<string> {
    this.calls.push(input);
    return this.handler(input);
  }
}
