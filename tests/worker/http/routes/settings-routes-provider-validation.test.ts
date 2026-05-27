import { describe, expect, it } from 'bun:test';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';

function validate(settings: Record<string, unknown>): { valid: boolean; error?: string } {
  const routes = new SettingsRoutes({} as never);
  return (routes as unknown as { validateSettings(input: unknown): { valid: boolean; error?: string } }).validateSettings(settings);
}

describe('SettingsRoutes provider validation', () => {
  it('accepts OpenAI-compatible provider IDs', () => {
    expect(validate({ CLAUDE_MEM_PROVIDER: 'openai-compatible' }).valid).toBe(true);
    expect(validate({ CLAUDE_MEM_PROVIDER: 'opencode-go' }).valid).toBe(true);
  });

  it('rejects invalid OpenAI-compatible base URLs', () => {
    const result = validate({ CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: 'not a url' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('CLAUDE_MEM_OPENAI_COMPAT_BASE_URL');
  });

  it('rejects invalid extra headers JSON', () => {
    expect(validate({ CLAUDE_MEM_OPENAI_COMPAT_HEADERS_JSON: '{' }).valid).toBe(false);
    expect(validate({ CLAUDE_MEM_OPENAI_COMPAT_HEADERS_JSON: '[]' }).valid).toBe(false);
    expect(validate({ CLAUDE_MEM_OPENAI_COMPAT_HEADERS_JSON: '{"X-Test":1}' }).valid).toBe(false);
  });
});
