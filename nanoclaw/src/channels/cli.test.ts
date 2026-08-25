import fs from 'fs';
import net from 'net';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelSetup } from './adapter.js';

const { TEST_DIR, registerChannelAdapter, getMessagingGroupByPlatform, getMessagingGroupAgents } = vi.hoisted(() => ({
  TEST_DIR: '/tmp/nanoclaw-cli-channel-test',
  registerChannelAdapter: vi.fn(),
  getMessagingGroupByPlatform: vi.fn(),
  getMessagingGroupAgents: vi.fn(),
}));

vi.mock('../config.js', () => ({ DATA_DIR: TEST_DIR }));
vi.mock('../db/messaging-groups.js', () => ({
  getMessagingGroupByPlatform,
  getMessagingGroupAgents,
}));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('./channel-registry.js', () => ({ registerChannelAdapter }));

import './cli.js';

function socketPath(): string {
  return path.join(TEST_DIR, 'cli.sock');
}

function setup(): ChannelSetup & { onInbound: ReturnType<typeof vi.fn>; onInboundEvent: ReturnType<typeof vi.fn> } {
  return {
    onInbound: vi.fn().mockResolvedValue(undefined),
    onInboundEvent: vi.fn().mockResolvedValue(undefined),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
  };
}

async function connect(): Promise<net.Socket> {
  const socket = net.connect(socketPath());
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

async function readError(socket: net.Socket): Promise<{ error: string }> {
  return new Promise((resolve, reject) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    socket.once('error', reject);
    socket.once('close', () => {
      void Promise.resolve()
        .then(() => JSON.parse(data.trim()) as { error: string })
        .then(resolve, reject);
    });
  });
}

describe('CLI channel plain-chat routing', () => {
  let adapter: ChannelAdapter;

  beforeEach(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    getMessagingGroupByPlatform.mockReset();
    getMessagingGroupAgents.mockReset();

    const registration = registerChannelAdapter.mock.calls[0]?.[1] as { factory: () => ChannelAdapter } | undefined;
    if (!registration) throw new Error('CLI adapter did not register');
    adapter = registration.factory();
  });

  afterEach(async () => {
    await adapter?.teardown();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('rejects an unwired cli/local chat with a JSON socket error before routing', async () => {
    getMessagingGroupByPlatform.mockReturnValue(undefined);
    const config = setup();
    await adapter.setup(config);

    const socket = await connect();
    const error = readError(socket);
    socket.write(JSON.stringify({ text: 'hello' }) + '\n');

    await expect(error).resolves.toEqual({ error: 'CLI target is not wired' });
    expect(config.onInbound).not.toHaveBeenCalled();
    expect(getMessagingGroupByPlatform).toHaveBeenCalledWith('cli', 'local', 'cli');
  });

  it('rejects ambiguous cli/local chat with a JSON socket error before routing', async () => {
    getMessagingGroupByPlatform.mockReturnValue({ id: 'cli-mg' });
    getMessagingGroupAgents.mockReturnValue([{ agent_group_id: 'a' }, { agent_group_id: 'b' }]);
    const config = setup();
    await adapter.setup(config);

    const socket = await connect();
    const error = readError(socket);
    socket.write(JSON.stringify({ text: 'hello' }) + '\n');

    await expect(error).resolves.toEqual({ error: 'CLI target is ambiguous: 2 agent groups are wired to cli/local' });
    expect(config.onInbound).not.toHaveBeenCalled();
  });

  it('preserves a caller-supplied virtual thread for one opted-in cli target', async () => {
    getMessagingGroupByPlatform.mockReturnValue({ id: 'cli-mg' });
    getMessagingGroupAgents.mockReturnValue([{ agent_group_id: 'benchmark' }]);
    const config = setup();
    await adapter.setup(config);

    expect(adapter.supportsThreads).toBe(true);
    expect(adapter.defaults?.dm.threads).toBe(false);

    const socket = await connect();
    socket.write(JSON.stringify({ text: 'hello', thread_id: 'trial-123', message_id: 'benchmark-input-123' }) + '\n');

    await vi.waitFor(() => {
      expect(config.onInbound).toHaveBeenCalledTimes(1);
    });
    expect(config.onInbound).toHaveBeenCalledWith(
      'local',
      'trial-123',
      expect.objectContaining({
        id: 'benchmark-input-123',
        content: { text: 'hello', sender: 'cli', senderId: 'cli:local' },
      }),
    );
    socket.end();
  });

  it('delivers concurrent virtual-thread replies to their matching clients', async () => {
    getMessagingGroupByPlatform.mockReturnValue({ id: 'cli-mg' });
    getMessagingGroupAgents.mockReturnValue([{ agent_group_id: 'benchmark' }]);
    const config = setup();
    await adapter.setup(config);

    const first = await connect();
    const second = await connect();
    let firstData = '';
    let secondData = '';
    first.on('data', (chunk) => { firstData += chunk.toString('utf8'); });
    second.on('data', (chunk) => { secondData += chunk.toString('utf8'); });
    first.write(JSON.stringify({ text: 'first', thread_id: 'trial-one' }) + '\n');
    second.write(JSON.stringify({ text: 'second', thread_id: 'trial-two' }) + '\n');

    await vi.waitFor(() => expect(config.onInbound).toHaveBeenCalledTimes(2));
    await adapter.deliver('local', 'trial-two', { kind: 'chat', content: { text: 'reply-two' } });
    await adapter.deliver('local', 'trial-one', { kind: 'chat', content: { text: 'reply-one' } });

    await vi.waitFor(() => {
      expect(firstData).toContain('reply-one');
      expect(secondData).toContain('reply-two');
    });
    expect(firstData).not.toContain('reply-two');
    expect(secondData).not.toContain('reply-one');
    first.end();
    second.end();
  });

  it('keeps routed to messages addressed by to.threadId', async () => {
    const config = setup();
    await adapter.setup(config);

    const socket = await connect();
    socket.write(
      JSON.stringify({
        text: 'admin message',
        thread_id: 'must-not-leak',
        to: { channelType: 'discord', platformId: 'discord-1', threadId: 'destination-thread' },
      }) + '\n',
    );

    await vi.waitFor(() => {
      expect(config.onInboundEvent).toHaveBeenCalledTimes(1);
    });
    expect(config.onInboundEvent).toHaveBeenCalledWith(
      expect.objectContaining({ channelType: 'discord', platformId: 'discord-1', threadId: 'destination-thread' }),
    );
    expect(config.onInbound).not.toHaveBeenCalled();
    socket.end();
  });
});
