/**
 * Helper to restart all running containers for an agent group.
 *
 * Writes an on_wake message to each session, kills the container, then
 * wakes a fresh container via the onExit callback — race-free.
 */
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import { countDueMessages, syncProcessingAcks } from './db/session-db.js';
import { getSession, getSessionsByAgentGroup } from './db/sessions.js';
import { log } from './log.js';
import { openInboundDb, openOutboundDb, writeSessionMessage } from './session-manager.js';

/**
 * Kill all running containers for an agent group and respawn them.
 *
 * Only targets sessions that actually have a running container.
 * If `wakeMessage` is provided, each session gets an on_wake message
 * (picked up only by the fresh container's first poll) and a
 * wakeContainer call on exit. Without it, containers are killed and
 * only come back on the next real user message.
 */
export function restartAgentGroupContainers(agentGroupId: string, reason: string, wakeMessage?: string): number {
  const sessions = getSessionsByAgentGroup(agentGroupId).filter(
    (s) => s.status === 'active' && isContainerRunning(s.id),
  );

  for (const session of sessions) {
    if (wakeMessage) {
      writeSessionMessage(agentGroupId, session.id, {
        id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: agentGroupId,
        channelType: 'agent',
        threadId: null,
        content: JSON.stringify({
          text: wakeMessage,
          sender: 'system',
          senderId: 'system',
        }),
        onWake: 1,
      });
    }
    // Decide whether to wake only after the old container has exited. It may
    // write its final processing acknowledgement after this restart request,
    // and a new inbound can land while it is shutting down.
    killContainer(
      session.id,
      reason,
      () => {
        const s = getSession(session.id);
        if (!s || s.status !== 'active') return;
        const hasPending = hasDueMessagesAfterAckSync(s.agent_group_id, s.id);
        if (wakeMessage || hasPending) void wakeContainer(s);
      },
    );
  }

  if (sessions.length > 0) {
    log.info('Restarting agent group containers', { agentGroupId, reason, count: sessions.length });
  }
  return sessions.length;
}

function hasDueMessagesAfterAckSync(agentGroupId: string, sessionId: string): boolean {
  const inDb = openInboundDb(agentGroupId, sessionId);
  try {
    try {
      const outDb = openOutboundDb(agentGroupId, sessionId);
      try {
        syncProcessingAcks(inDb, outDb);
      } finally {
        outDb.close();
      }
    } catch {
      // A first-spawn session may not have an outbound DB yet. Preserve the
      // existing pending-work behavior rather than blocking its restart.
    }
    return countDueMessages(inDb) > 0;
  } finally {
    inDb.close();
  }
}
