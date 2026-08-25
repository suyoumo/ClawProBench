import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetContainerConfig = vi.fn();
const mockUpdateContainerConfigScalars = vi.fn();
const mockUpdateContainerConfigThenRestart = vi.fn();

vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: (...args: unknown[]) => mockGetContainerConfig(...args),
  updateContainerConfigScalars: (...args: unknown[]) => mockUpdateContainerConfigScalars(...args),
  updateContainerConfigJson: vi.fn(),
}));
vi.mock('../../container-config-update.js', () => ({
  updateContainerConfigThenRestart: (...args: unknown[]) => mockUpdateContainerConfigThenRestart(...args),
}));
vi.mock('../../container-runner.js', () => ({
  buildAgentGroupImage: vi.fn(),
  killContainer: vi.fn(),
  wakeContainer: vi.fn(),
}));
vi.mock('../../container-restart.js', () => ({ restartAgentGroupContainers: vi.fn() }));
vi.mock('../../db/agent-groups.js', () => ({ createAgentGroup: vi.fn() }));
vi.mock('../../db/connection.js', () => ({ getDb: vi.fn(), hasTable: vi.fn() }));
vi.mock('../../db/sessions.js', () => ({ getSession: vi.fn() }));
vi.mock('../../session-manager.js', () => ({ writeSessionMessage: vi.fn() }));
vi.mock('../../group-init.js', () => ({ initGroupFilesystem: vi.fn() }));
vi.mock('../../templates/create-agent.js', () => ({ createAgentFromTemplate: vi.fn() }));

import { lookup } from '../registry.js';
import './groups.js';

const configRow = {
  agent_group_id: 'group-1',
  provider: 'opencode',
  model: 'glm/glm-5-turbo',
  effort: null,
  image_tag: null,
  assistant_name: null,
  max_messages_per_prompt: null,
  skills: '[]',
  mcp_servers: '{}',
  packages_apt: '[]',
  packages_npm: '[]',
  additional_mounts: '[]',
  cli_scope: 'group',
  updated_at: '2026-07-13T00:00:00.000Z',
};

describe('groups config update --restart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the ordered persist-then-restart helper only when requested', async () => {
    mockGetContainerConfig.mockReturnValue(configRow);
    mockUpdateContainerConfigThenRestart.mockReturnValue(1);

    const command = lookup('groups-config-update')!;
    const args = command.parseArgs({
      id: 'group-1',
      provider: 'opencode',
      model: 'deepseek/deepseek-v4-flash',
      restart: true,
    });
    const result = (await command.handler(args, { caller: 'host' })) as Record<string, unknown>;

    expect(mockUpdateContainerConfigThenRestart).toHaveBeenCalledWith('group-1', {
      provider: 'opencode',
      model: 'deepseek/deepseek-v4-flash',
    });
    expect(mockUpdateContainerConfigScalars).not.toHaveBeenCalled();
    expect(result.restarted).toBe(1);
  });

  it('persists without restarting when --restart is absent', async () => {
    mockGetContainerConfig.mockReturnValue(configRow);

    const command = lookup('groups-config-update')!;
    const args = command.parseArgs({ id: 'group-1', model: 'volcengine-plan/kimi-k2.6' });
    await command.handler(args, { caller: 'host' });

    expect(mockUpdateContainerConfigScalars).toHaveBeenCalledWith('group-1', {
      model: 'volcengine-plan/kimi-k2.6',
    });
    expect(mockUpdateContainerConfigThenRestart).not.toHaveBeenCalled();
  });
});
