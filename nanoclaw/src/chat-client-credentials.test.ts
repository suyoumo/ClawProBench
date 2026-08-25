import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const chatClient = fs.readFileSync(path.join(process.cwd(), 'scripts', 'chat.ts'), 'utf8');

describe('chat client credential ownership', () => {
  it('is a Unix-socket-only transport', () => {
    expect(chatClient).toContain("import net from 'net'");
    expect(chatClient).toContain('net.connect(socketPath())');
  });

  it('carries an optional transport thread without adding routing configuration', () => {
    expect(chatClient).toContain('--thread-id');
    expect(chatClient).toContain('thread_id: threadId');
  });

  it('does not own inference credentials or clients', () => {
    expect(chatClient).not.toMatch(
      /ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|OPENCODE_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/,
    );
    expect(chatClient).not.toMatch(/@anthropic-ai|@opencode-ai|createOpencodeClient|new Anthropic/);
    expect(chatClient).not.toMatch(/\bfetch\s*\(|https?\.request\s*\(/);
  });
});
