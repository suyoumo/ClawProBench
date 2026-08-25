/**
 * CLI channel — talk to your agent from a local terminal via Unix socket.
 *
 * Always-on, zero-credentials channel that ships with main. The daemon
 * listens on `data/cli.sock`; the `scripts/chat.ts` client connects, writes
 * a JSON line per message, reads JSON lines back. The channel plumbs into
 * the normal router/delivery path like any other adapter — `/clear` and
 * other session-level commands work identically.
 *
 * Wire format: one JSON object per line.
 *
 *   Client → server:
 *     { "text": "user message" }                          # default — talk to cli/local
 *     { "text": "...", "thread_id": "trial-123" }        # optional virtual thread
 *     { "text": "...", "message_id": "benchmark-123" }   # caller-selected inbound id
 *     { "text": "...", "to": {"channelType": "discord",
 *                             "platformId": "discord:@me:149...",
 *                             "threadId": null} }         # route to a specific mg
 *     { "text": "...", "to": {...}, "reply_to": {...} }   # + redirect replies
 *   Server → client:
 *     { "text": "agent reply" }
 *
 * The `to` and `reply_to` addressing is how admin transports (the bootstrap
 * script) inject messages targeting any wired channel. `reply_to` is a
 * router-layer concept — agents cannot set it; it is carried only on
 * inbound events from CLI clients that hold operator privilege (the socket
 * is chmod 0600, so "connected to this socket" ≈ "is the owner").
 *
 * Plain terminal chat retains single-client semantics: a second unthreaded
 * connection closes the first with a "superseded" notice. Threaded clients
 * are independently correlated by their virtual thread IDs so an isolated
 * benchmark can run several scenarios at once without mixing replies. Admin
 * route-opcode connections (`to` set) are one-shot and do NOT claim either
 * kind of chat slot.
 *
 * deliver() silently no-ops when no client is connected. The outbound row
 * is already in outbound.db, so the message isn't lost — it just doesn't
 * reach this run's terminal. Reconnect to see subsequent replies.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { log } from '../log.js';
import type {
  ChannelAdapter,
  ChannelDefaults,
  ChannelSetup,
  DeliveryAddress,
  InboundEvent,
  OutboundMessage,
} from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { requireUniqueCliTarget } from './cli-target.js';

const PLATFORM_ID = 'local';

/**
 * Terminal transport: every line the operator types is for the agent
 * (pattern '.'), the socket is owner-only so senders are trusted ('public'),
 * and there is no platform-native mention or thread concept. It can still
 * carry virtual thread IDs for an explicitly opted-in wiring. Matches what
 * scripts/init-cli-agent.ts has always created.
 */
const CLI_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  mentions: 'never',
};

function socketPath(): string {
  return path.join(DATA_DIR, 'cli.sock');
}

function createAdapter(): ChannelAdapter {
  let server: net.Server | null = null;
  let client: net.Socket | null = null;
  const threadClients = new Map<string, net.Socket>();

  const adapter: ChannelAdapter = {
    name: 'cli',
    channelType: 'cli',
    // CLI can carry caller-supplied virtual thread IDs. Default wirings keep
    // threads disabled, while an isolated benchmark wiring can opt in.
    supportsThreads: true,
    defaults: CLI_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      const sock = socketPath();

      // Stale socket cleanup: a previous run that crashed may have left the
      // file behind, and net.createServer refuses to bind to an existing path.
      try {
        fs.unlinkSync(sock);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'ENOENT') {
          log.warn('Failed to unlink stale CLI socket (will try to bind anyway)', { sock, err });
        }
      }

      server = net.createServer((socket) => handleConnection(socket, config));
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(sock, () => {
          // Tighten perms so only the owner can connect. Unix socket files
          // obey filesystem perms — 0700 on the socket means other local
          // users can't send into this agent.
          try {
            fs.chmodSync(sock, 0o600);
          } catch (err) {
            log.warn('Failed to chmod CLI socket (continuing)', { sock, err });
          }
          log.info('CLI channel listening', { sock });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      if (client) {
        try {
          client.end();
        } catch {
          // swallow — teardown is best-effort
        }
        client = null;
      }
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
        });
        server = null;
      }
      // Remove the socket file so a relaunch doesn't trip over it.
      try {
        fs.unlinkSync(socketPath());
      } catch {
        // swallow
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    async deliver(platformId, threadId, message: OutboundMessage): Promise<string | undefined> {
      if (platformId !== PLATFORM_ID) return undefined;
      const recipient = threadId ? threadClients.get(threadId) : client;
      if (!recipient) {
        // No live terminal — outbound row is already persisted, so this
        // isn't a data loss. User will see it on the next connect cycle
        // (or never, if we don't add scroll-back). Not worth throwing.
        return undefined;
      }
      const text = extractText(message);
      if (text === null) return undefined;
      try {
        recipient.write(JSON.stringify({ text }) + '\n');
      } catch (err) {
        log.warn('Failed to write to CLI client', { err });
      }
      return undefined;
    },
  };

  function handleConnection(socket: net.Socket, config: ChannelSetup): void {
    // Defer the chat-slot swap until we see the first line — if it turns out
    // to be a routed (`to`-bearing) one-shot, we leave the existing chat
    // client in place. Only plain chat connections participate in supersede.
    let claimedChatSlot = false;
    let claimedThreadId: string | null = null;

    const claimChatSlot = (threadId: string | null): boolean => {
      if (claimedChatSlot) {
        if (claimedThreadId === threadId) return true;
        writeSocketError(socket, 'CLI connection cannot switch virtual threads');
        return false;
      }
      claimedChatSlot = true;
      claimedThreadId = threadId;
      if (threadId) {
        const previous = threadClients.get(threadId);
        if (previous && previous !== socket) {
          try {
            previous.write(JSON.stringify({ text: '[superseded by a newer client for this thread]' }) + '\n');
            previous.end();
          } catch {
            // swallow
          }
        }
        threadClients.set(threadId, socket);
        log.info('CLI threaded client connected', { threadId });
        return true;
      }
      if (client && client !== socket) {
        try {
          client.write(JSON.stringify({ text: '[superseded by a newer client]' }) + '\n');
          client.end();
        } catch {
          // swallow
        }
      }
      client = socket;
      log.info('CLI client connected');
      return true;
    };

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        void handleLine(line, config, claimChatSlot, socket);
      }
    });

    socket.on('close', () => {
      if (client === socket) client = null;
      if (claimedThreadId && threadClients.get(claimedThreadId) === socket) {
        threadClients.delete(claimedThreadId);
      }
      if (claimedChatSlot) log.info('CLI client disconnected');
    });

    socket.on('error', (err) => {
      log.warn('CLI client socket error', { err });
    });
  }

  async function handleLine(
    line: string,
    config: ChannelSetup,
    claimChatSlot: (threadId: string | null) => boolean,
    socket: net.Socket,
  ): Promise<void> {
    let payload: {
      text?: unknown;
      to?: unknown;
      reply_to?: unknown;
      thread_id?: unknown;
      message_id?: unknown;
      sender?: unknown;
      senderId?: unknown;
    };
    try {
      payload = JSON.parse(line);
    } catch (_err) {
      log.warn('CLI: ignoring non-JSON line from client', { line });
      return;
    }
    if (typeof payload.text !== 'string' || payload.text.length === 0) return;

    const to = parseAddress(payload.to);
    const replyTo = parseAddress(payload.reply_to);

    if (to) {
      // Routed message — admin transport. Build a full InboundEvent targeting
      // `to`'s channel/platform, and let `reply_to` (if any) redirect replies.
      // Does NOT claim the chat slot, so an active terminal chat isn't evicted.
      const event: InboundEvent = {
        channelType: to.channelType,
        platformId: to.platformId,
        threadId: to.threadId,
        message: {
          id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: JSON.stringify({
            text: payload.text,
            sender: typeof payload.sender === 'string' ? payload.sender : 'cli',
            senderId: typeof payload.senderId === 'string' ? payload.senderId : `cli:${PLATFORM_ID}`,
          }),
        },
        replyTo: replyTo ?? undefined,
      };
      try {
        await config.onInboundEvent(event);
      } catch (err) {
        log.error('CLI: onInboundEvent threw', { err });
      }
      return;
    }

    // Plain chat has no explicit target address, so it must not fan out to
    // multiple cli/local wirings. Check before claiming the client slot or
    // entering the router, which otherwise legitimately fans out by design.
    try {
      const cliGroup = getMessagingGroupByPlatform('cli', PLATFORM_ID, 'cli');
      requireUniqueCliTarget(cliGroup ? getMessagingGroupAgents(cliGroup.id) : []);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'CLI target validation failed';
      writeSocketError(socket, message);
      log.warn('CLI: plain chat rejected', { err });
      return;
    }

    const threadId = typeof payload.thread_id === 'string' ? payload.thread_id : null;
    const messageId = typeof payload.message_id === 'string' && payload.message_id.length > 0
      ? payload.message_id
      : `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Plain chat — bind a virtual-thread client to its own reply stream,
    // while unthreaded terminal chat keeps the legacy single-client slot.
    if (!claimChatSlot(threadId)) return;
    try {
      await config.onInbound(PLATFORM_ID, threadId, {
        id: messageId,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: {
          text: payload.text,
          sender: 'cli',
          senderId: `cli:${PLATFORM_ID}`,
        },
      });
    } catch (err) {
      log.error('CLI: onInbound threw', { err });
    }
  }

  function parseAddress(raw: unknown): DeliveryAddress | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.channelType !== 'string' || typeof obj.platformId !== 'string') return null;
    const threadId =
      obj.threadId === null || obj.threadId === undefined
        ? null
        : typeof obj.threadId === 'string'
          ? obj.threadId
          : null;
    return {
      channelType: obj.channelType,
      platformId: obj.platformId,
      threadId,
    };
  }

  return adapter;
}

function writeSocketError(socket: net.Socket, message: string): void {
  try {
    socket.write(JSON.stringify({ error: message }) + '\n');
    socket.end();
  } catch (err) {
    log.warn('Failed to write CLI socket error', { err });
  }
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

registerChannelAdapter('cli', { factory: createAdapter, defaults: CLI_DEFAULTS });
