/**
 * ncl — chat with your NanoClaw agent from the terminal.
 *
 * Usage:
 *   pnpm run chat [--thread-id <id>] [--message-id <id>] [--total-timeout-ms <ms>] <message...>
 *
 * Sends the message through the CLI channel (Unix socket) to the wired agent.
 * Reads replies until the stream goes quiet, then exits.
 *
 * Preconditions: NanoClaw host service running, an agent group wired to
 * `cli/local` via `/init-first-agent` or `/manage-channels`.
 */
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../src/config.js';

const SILENCE_MS = 2000; // exit after this much quiet time following the first reply
const DEFAULT_TOTAL_TIMEOUT_MS = 120_000; // hard stop when callers do not override it

function socketPath(): string {
  return path.join(DATA_DIR, 'cli.sock');
}

function main(): void {
  const { threadId, messageId, totalTimeoutMs, words } = parseArgs(process.argv.slice(2));
  if (words.length === 0) {
    console.error('usage: pnpm run chat [--thread-id <id>] [--message-id <id>] [--total-timeout-ms <ms>] <message...>');
    process.exit(1);
  }
  const text = words.join(' ');

  const socket = net.connect(socketPath());

  socket.on('error', (err) => {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
      console.error(`NanoClaw daemon not reachable at ${socketPath()}.`);
      console.error('Start the service (launchctl/systemd) before running ncl.');
    } else {
      console.error('CLI socket error:', err);
    }
    process.exit(2);
  });

  let firstReplySeen = false;
  let errorSeen = false;
  let silenceTimer: NodeJS.Timeout | null = null;
  let hardTimer: NodeJS.Timeout | null = null;

  function scheduleExit(): void {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      socket.end();
      process.exit(0);
    }, SILENCE_MS);
  }

  socket.on('connect', () => {
    socket.write(
      JSON.stringify({
        text,
        ...(threadId ? { thread_id: threadId } : {}),
        ...(messageId ? { message_id: messageId } : {}),
      }) + '\n',
    );
    hardTimer = setTimeout(() => {
      if (!firstReplySeen) {
        console.error(`timeout: no reply in ${totalTimeoutMs}ms`);
        socket.end();
        process.exit(3);
      }
    }, totalTimeoutMs);
  });

  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.text === 'string') {
          process.stdout.write(msg.text + '\n');
          firstReplySeen = true;
          if (hardTimer) {
            clearTimeout(hardTimer);
            hardTimer = null;
          }
          scheduleExit();
        } else if (typeof msg.error === 'string') {
          errorSeen = true;
          if (hardTimer) {
            clearTimeout(hardTimer);
            hardTimer = null;
          }
          console.error(`CLI error: ${msg.error}`);
          socket.end();
        }
      } catch {
        // Ignore non-JSON lines — forward compatibility.
      }
    }
  });

  socket.on('close', () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (hardTimer) clearTimeout(hardTimer);
    process.exit(firstReplySeen ? 0 : errorSeen ? 2 : 3);
  });
}

function parseArgs(argv: string[]): { threadId?: string; messageId?: string; totalTimeoutMs: number; words: string[] } {
  const words: string[] = [];
  let threadId: string | undefined;
  let messageId: string | undefined;
  let totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--thread-id') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        console.error('chat: --thread-id requires a non-empty value');
        process.exit(1);
      }
      threadId = value;
    } else if (argv[i] === '--message-id') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        console.error('chat: --message-id requires a non-empty value');
        process.exit(1);
      }
      messageId = value;
    } else if (argv[i] === '--total-timeout-ms') {
      const value = argv[++i];
      const parsed = value ? Number(value) : Number.NaN;
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        console.error('chat: --total-timeout-ms requires a positive integer');
        process.exit(1);
      }
      totalTimeoutMs = parsed;
    } else {
      words.push(argv[i]!);
    }
  }

  return { threadId, messageId, totalTimeoutMs, words };
}

main();
