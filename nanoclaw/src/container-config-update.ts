/**
 * Persist a container config update before restarting its running sessions.
 *
 * Keeping this sequence in one narrow helper gives callers a testable
 * guarantee that a restart cannot observe an unpersisted provider or model.
 */
import { restartAgentGroupContainers } from './container-restart.js';
import { updateContainerConfigScalars } from './db/container-configs.js';
import type { ContainerConfigRow } from './types.js';

export type ContainerConfigScalarUpdates = Partial<
  Pick<
    ContainerConfigRow,
    'provider' | 'model' | 'effort' | 'image_tag' | 'assistant_name' | 'max_messages_per_prompt' | 'cli_scope'
  >
>;

export type ContainerConfigUpdateDeps = {
  update: (agentGroupId: string, updates: ContainerConfigScalarUpdates) => void;
  restart: (agentGroupId: string, reason: string) => number;
};

const defaultDeps: ContainerConfigUpdateDeps = {
  update: updateContainerConfigScalars,
  restart: restartAgentGroupContainers,
};

export function updateContainerConfigThenRestart(
  agentGroupId: string,
  updates: ContainerConfigScalarUpdates,
  deps: ContainerConfigUpdateDeps = defaultDeps,
): number {
  deps.update(agentGroupId, updates);
  return deps.restart(agentGroupId, 'container config updated');
}
