import { describe, expect, it } from 'bun:test';
import {
  buildChatCompletionsUrl,
  classifyOpenAICompatibleError,
  getSelectedOpenAICompatibleConfig,
  parseOpenAICompatibleHeaders,
  queryOpenAICompatibleChatCompletion,
} from '../../src/services/worker/OpenRouterProvider.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
  });
}

describe('OpenAI-compatible worker provider helpers', () => {
  it('builds chat completions URLs from base URLs', () => {
    expect(buildChatCompletionsUrl('https://opencode.ai/zen/go/v1')).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    expect(buildChatCompletionsUrl('https://example.test/v1/chat/completions')).toBe('https://example.test/v1/chat/completions');
  });

  it('parses custom JSON headers', () => {
    expect(parseOpenAICompatibleHeaders('{"X-Test":"yes"}')).toEqual({ 'X-Test': 'yes' });
    expect(() => parseOpenAICompatibleHeaders('[]')).toThrow('JSON object');
    expect(() => parseOpenAICompatibleHeaders('{"X-Test":1}')).toThrow('values must be strings');
  });

  it('sends OpenAI-style chat completions requests with auth and custom headers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse(200, {
        choices: [{ message: { content: '<observation><type>x</type></observation>' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    };

    const result = await queryOpenAICompatibleChatCompletion({
      providerName: 'Test Provider',
      baseUrl: 'https://example.test/v1',
      apiKey: 'sk-test',
      model: 'model-a',
      messages: [{ role: 'user', content: 'hello' }],
      headers: { 'X-Test': 'yes' },
      fetchImpl,
    });

    expect(result.content).toContain('<observation>');
    expect(result.tokensUsed).toBe(15);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.test/v1/chat/completions');
    expect(calls[0].init.headers).toMatchObject({
      Authorization: 'Bearer sk-test',
      'Content-Type': 'application/json',
      'X-Test': 'yes',
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: 'model-a',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.3,
      max_tokens: 4096,
    });
  });

  it('returns empty content when choices are missing', async () => {
    const result = await queryOpenAICompatibleChatCompletion({
      providerName: 'Test Provider',
      baseUrl: 'https://example.test/v1',
      apiKey: 'sk-test',
      model: 'model-a',
      messages: [{ role: 'user', content: 'hello' }],
      fetchImpl: async () => jsonResponse(200, { choices: [] }),
    });

    expect(result).toEqual({ content: '' });
  });

  it('classifies OpenAI-compatible provider errors', () => {
    expect(classifyOpenAICompatibleError({ status: 401, cause: new Error('bad'), providerName: 'X' }).kind).toBe('auth_invalid');
    expect(classifyOpenAICompatibleError({ status: 429, cause: new Error('rl'), providerName: 'X' }).kind).toBe('rate_limit');
    expect(classifyOpenAICompatibleError({ status: 500, bodyText: 'insufficient credits', cause: new Error('quota'), providerName: 'X' }).kind).toBe('quota_exhausted');
    expect(classifyOpenAICompatibleError({ status: 502, cause: new Error('bad gateway'), providerName: 'X' }).kind).toBe('transient');
    expect(classifyOpenAICompatibleError({ cause: new Error('ECONNRESET'), providerName: 'X' }).kind).toBe('transient');
  });

  it('resolves OpenCode Go and OpenRouter presets from settings/env', () => {
    const originalProvider = process.env.CLAUDE_MEM_PROVIDER;
    const originalGoKey = process.env.CLAUDE_MEM_OPENCODE_GO_API_KEY;
    const originalOpenRouterKey = process.env.CLAUDE_MEM_OPENROUTER_API_KEY;
    const originalHeadersJson = process.env.CLAUDE_MEM_OPENAI_COMPAT_HEADERS_JSON;
    try {
      process.env.CLAUDE_MEM_PROVIDER = 'opencode-go';
      process.env.CLAUDE_MEM_OPENCODE_GO_API_KEY = 'go-key';
      process.env.CLAUDE_MEM_OPENAI_COMPAT_HEADERS_JSON = '{}';
      let config = getSelectedOpenAICompatibleConfig();
      expect(config.providerId).toBe('opencode-go');
      expect(config.providerName).toBe('OpenCode Go');
      expect(config.baseUrl).toBe('https://opencode.ai/zen/go/v1');
      expect(config.model).toBe('deepseek-v4-flash');
      expect(config.apiKey).toBe('go-key');

      process.env.CLAUDE_MEM_PROVIDER = 'openrouter';
      process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'or-key';
      config = getSelectedOpenAICompatibleConfig();
      expect(config.providerId).toBe('openrouter');
      expect(config.baseUrl).toBe('https://openrouter.ai/api/v1');
      expect(config.headers).toMatchObject({
        'HTTP-Referer': 'https://github.com/thedotmack/claude-mem',
        'X-Title': 'claude-mem',
      });
    } finally {
      restoreEnv('CLAUDE_MEM_PROVIDER', originalProvider);
      restoreEnv('CLAUDE_MEM_OPENCODE_GO_API_KEY', originalGoKey);
      restoreEnv('CLAUDE_MEM_OPENROUTER_API_KEY', originalOpenRouterKey);
      restoreEnv('CLAUDE_MEM_OPENAI_COMPAT_HEADERS_JSON', originalHeadersJson);
      // Touch defaults so the import is not optimized away in older Bun builds.
      expect(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_OPENCODE_GO_MODEL).toBe('deepseek-v4-flash');
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
