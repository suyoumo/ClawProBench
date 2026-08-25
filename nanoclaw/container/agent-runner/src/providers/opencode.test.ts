import { afterEach, describe, expect, it } from 'bun:test';

import { buildOpenCodeConfig } from './opencode.js';

const saved = {
  provider: process.env.OPENCODE_PROVIDER,
  model: process.env.OPENCODE_MODEL,
  baseUrl: process.env.OPENCODE_BASE_URL,
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
};

afterEach(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore('OPENCODE_PROVIDER', saved.provider);
  restore('OPENCODE_MODEL', saved.model);
  restore('OPENCODE_BASE_URL', saved.baseUrl);
  restore('ANTHROPIC_BASE_URL', saved.anthropicBaseUrl);
});

describe('buildOpenCodeConfig', () => {
  it('uses the persisted upstream endpoint instead of an absent Anthropic base URL', () => {
    process.env.OPENCODE_PROVIDER = 'deepseek';
    process.env.OPENCODE_MODEL = 'deepseek/deepseek-v4-flash';
    process.env.OPENCODE_BASE_URL = 'https://api.deepseek.com';
    delete process.env.ANTHROPIC_BASE_URL;

    const config = buildOpenCodeConfig({ mcpServers: {} }) as {
      provider: Record<string, { options: Record<string, string> }>;
    };

    expect(config.provider.deepseek?.options).toEqual({
      apiKey: 'placeholder',
      baseURL: 'https://api.deepseek.com',
    });
  });
});
