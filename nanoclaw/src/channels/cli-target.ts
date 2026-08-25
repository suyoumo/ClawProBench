/** Require the local CLI chat endpoint to have exactly one routing target. */
export function requireUniqueCliTarget<T>(targets: readonly T[]): T {
  if (targets.length === 1) return targets[0]!;

  if (targets.length === 0) {
    throw new Error('CLI target is not wired');
  }

  throw new Error(`CLI target is ambiguous: ${targets.length} agent groups are wired to cli/local`);
}
