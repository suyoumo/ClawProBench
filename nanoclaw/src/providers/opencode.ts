/**
 * Host-side container config for the `opencode` provider.
 *
 * OpenCode's `opencode serve` process stores state under XDG_DATA_HOME, which
 * we pin to a per-session host directory mounted at /opencode-xdg. The
 * OPENCODE_* env vars tell the CLI which provider/model to use at runtime
 * (read on the host, injected into the container). NO_PROXY / no_proxy are
 * merged with host values so the in-container OpenCode client can talk to
 * 127.0.0.1 even when HTTPS_PROXY is set by OneCLI.
 */
import fs from 'fs';
import path from 'path';

import {
  registerProviderContainerConfig,
  type ProviderContainerContext,
  type ProviderContainerContribution,
} from './provider-container-registry.js';

export function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

function upstreamProviderFromModel(model: string | undefined): string {
  if (!model) return 'anthropic';
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : 'anthropic';
}

// OpenCode still makes the request to the upstream hostname; OneCLI's HTTPS
// proxy intercepts that request and injects the matching vault credential.
// These are the fixed benchmark routes, keyed by the persisted model prefix.
const KNOWN_UPSTREAM_BASE_URLS: Readonly<Record<string, string>> = {
  'volcengine-plan': 'https://ark.cn-beijing.volces.com/api/coding/v3',
  glm: 'https://open.bigmodel.cn/api/coding/paas/v4',
  deepseek: 'https://api.deepseek.com',
  'bailian-compatible': 'https://llm-27ittr8vhpvvxvso.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
};

export function upstreamBaseUrlFromModel(model: string | undefined): string | undefined {
  return KNOWN_UPSTREAM_BASE_URLS[upstreamProviderFromModel(model)];
}

/**
 * Build the OpenCode-specific part of a container spawn from persisted
 * configuration. Host OPENCODE_* values deliberately do not participate:
 * they would make one group's model selection leak into another group.
 */
export function buildOpenCodeContainerContribution(ctx: ProviderContainerContext): ProviderContainerContribution {
  const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
  fs.mkdirSync(opencodeDir, { recursive: true });

  const model = ctx.model?.trim() || undefined;
  const baseUrl = upstreamBaseUrlFromModel(model);

  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost'),
    OPENCODE_PROVIDER: upstreamProviderFromModel(model),
    ...(model ? { OPENCODE_MODEL: model } : {}),
    ...(baseUrl ? { OPENCODE_BASE_URL: baseUrl } : {}),
  };

  return {
    mounts: [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }],
    env,
  };
}

registerProviderContainerConfig('opencode', buildOpenCodeContainerContribution);
