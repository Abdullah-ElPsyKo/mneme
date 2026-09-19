import { z } from 'zod';
import { AppError } from '../core/types.js';
import type { Settings } from '../security/settings.js';
import { isLoopback, validateEndpoint } from '../security/settings.js';
export type ModelRequest = { system: string; prompt: string; cloudConsent?: boolean; signal?: AbortSignal };
export interface ModelProvider {
  capabilities(): {
    generate: boolean;
    stream: boolean;
    embed: boolean;
    local: boolean;
    model: string;
    provider: string;
  };
  generate(request: ModelRequest): Promise<string>;
  stream(request: ModelRequest): AsyncIterable<string>;
  embed(text: string, cloudConsent?: boolean): Promise<number[]>;
}
export class HttpModelProvider implements ModelProvider {
  constructor(
    readonly settings: Settings,
    readonly deadlines = { startupMs: 120_000, idleMs: 60_000 },
  ) {}
  capabilities() {
    const s = this.settings.data;
    return {
      generate: s.provider !== 'disabled' && !!s.model,
      stream: s.provider !== 'disabled' && !!s.model,
      embed: s.provider !== 'disabled' && !!s.embedding_model,
      local: isLoopback(s.endpoint),
      model: s.model,
      provider: s.provider,
    };
  }
  async request(path: string, payload: unknown, consent = false, signal?: AbortSignal) {
    const s = this.settings.data;
    if (s.provider === 'disabled')
      throw new AppError(503, 'AI is disabled. Local evidence is still available.');
    const url = validateEndpoint(s.endpoint, s.local_only);
    if (!isLoopback(url.href) && !consent)
      throw new AppError(
        403,
        'Sending selected evidence to this external provider requires explicit consent',
      );
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const key = this.settings.secret();
    if (key) headers.Authorization = `Bearer ${key}`;
    const controller = new AbortController();
    let received = false;
    let timer: ReturnType<typeof setTimeout>;
    const arm = (milliseconds: number) => {
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          controller.abort(
            new AppError(
              503,
              received
                ? 'Model generation stalled: no response data for 60 seconds. Retrieved evidence remains available.'
                : 'Model did not begin responding within the startup window. It may still be loading or processing the prompt. Retry or use less context.',
            ),
          ),
        milliseconds,
      );
      timer.unref();
    };
    const close = () => clearTimeout(timer);
    const progress = () => {
      received = true;
      arm(this.deadlines.idleMs);
    };
    const failure = (error: unknown): Error => {
      if (signal?.aborted) return signal.reason;
      if (controller.signal.aborted) return controller.signal.reason;
      if (error instanceof AppError) return error;
      return new AppError(
        503,
        isLoopback(s.endpoint)
          ? 'Local model unavailable. Your memory and search are still available.'
          : 'External model unavailable. Your memory and search are still available.',
      );
    };
    // Bound model loading/prefill, then reset the deadline whenever bytes arrive.
    // There is deliberately no total generation deadline for a progressing stream.
    arm(isLoopback(s.endpoint) ? this.deadlines.startupMs : this.deadlines.idleMs);
    try {
      const response = await fetch(url.href.replace(/\/$/, '') + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(502, `Model endpoint returned HTTP ${response.status}`);
      }
      return { response, close, progress, failure };
    } catch (error) {
      close();
      throw failure(error);
    }
  }
  async limitedJson(transport: Awaited<ReturnType<HttpModelProvider['request']>>) {
    if (!transport.response.body) {
      transport.close();
      throw new AppError(502, 'Empty model response');
    }
    const reader = transport.response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value.length) transport.progress();
        size += value.length;
        if (size > 8 * 1024 * 1024) throw new AppError(502, 'Model response exceeded size limit');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      throw transport.failure(error);
    } finally {
      transport.close();
      await reader.cancel().catch(() => {});
    }
  }
  async generate(request: ModelRequest) {
    let text = '';
    for await (const chunk of this.stream(request)) text += chunk;
    return text;
  }
  async *stream(request: ModelRequest): AsyncIterable<string> {
    const s = this.settings.data;
    if (!s.model) throw new AppError(400, 'Choose a model in Settings');
    const messages = [
      { role: 'system', content: request.system },
      { role: 'user', content: request.prompt },
    ];
    const ollama = s.provider === 'ollama';
    const transport = await this.request(
      ollama ? '/api/chat' : '/chat/completions',
      {
        model: s.model,
        messages,
        stream: true,
        ...(ollama ? { think: false, options: { num_predict: 2048 } } : { max_tokens: 2048 }),
      },
      request.cloudConsent,
      request.signal,
    );
    const { response } = transport;
    if (!response.body) {
      transport.close();
      throw new AppError(502, 'Empty model response');
    }
    if (response.headers.get('content-type')?.includes('application/json') && !ollama) {
      const data = await this.limitedJson(transport);
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new AppError(502, 'Invalid model response');
      yield text;
      return;
    }
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = '',
      bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value?.length) transport.progress();
        buffer += done ? decoder.decode() + '\n' : decoder.decode(value, { stream: true });
        bytes += value?.length || 0;
        if (bytes > 8 * 1024 * 1024) throw new AppError(502, 'Model response exceeded size limit');
        let boundary: number;
        while ((boundary = buffer.indexOf('\n')) >= 0) {
          let line = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 1);
          if (!line || line.startsWith(':') || (!ollama && !line.startsWith('data:'))) continue;
          if (line.startsWith('data:')) line = line.slice(5).trim();
          if (line === '[DONE]') return;
          let data: any;
          try {
            data = JSON.parse(line);
          } catch {
            throw new AppError(502, 'Malformed model stream');
          }
          if (data.error) throw new AppError(502, 'Model reported an error');
          const fragment = ollama ? data.message?.content : data.choices?.[0]?.delta?.content;
          if (typeof fragment === 'string') yield fragment;
        }
        if (done) break;
      }
    } catch (error) {
      throw transport.failure(error);
    } finally {
      transport.close();
      await reader.cancel().catch(() => {});
    }
  }
  async embed(text: string, cloudConsent = false) {
    const s = this.settings.data;
    if (!s.embedding_model) throw new AppError(400, 'Embeddings are not configured');
    const ollama = s.provider === 'ollama';
    const response = await this.request(
      ollama ? '/api/embed' : '/embeddings',
      { model: s.embedding_model, input: text.slice(0, 30000) },
      cloudConsent,
    );
    const result = await this.limitedJson(response);
    return z
      .array(z.number().finite())
      .min(1)
      .max(32768)
      .parse(ollama ? result.embeddings?.[0] : result.data?.[0]?.embedding);
  }
  fingerprint() {
    const s = this.settings.data;
    return `${s.provider}|${s.endpoint}|${s.embedding_model}`;
  }
}
