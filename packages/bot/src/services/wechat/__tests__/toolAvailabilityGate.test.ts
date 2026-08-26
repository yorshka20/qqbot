// The wechat_* tool specs are registered by an import-time decorator, long
// before anything knows whether the plugin behind them is enabled. This covers
// the path they use to ask: WeChatIngestPlugin.isEnabled() → PluginManager,
// wired into ToolSpec.available.

import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import { WeChatIngestPlugin } from '@/services/wechat/plugins';
import { ToolManager } from '@/tools/ToolManager';
import type { ToolSpec } from '@/tools/types';

const enabled = new Set<string>();

getContainer().registerInstance(
  DITokens.PLUGIN_MANAGER,
  { isPluginEnabled: (name: string) => enabled.has(name) },
  { allowOverride: true },
);

function catalogWith(spec: ToolSpec): string[] {
  const manager = new ToolManager();
  manager.registerTool(spec);
  return manager.getToolsByScope('subagent').map((t) => t.name);
}

const wechatTool: ToolSpec = {
  name: 'wechat_article_rag',
  description: 'semantic search over ingested WeChat articles',
  executor: 'wechat_article_rag',
  visibility: { subagent: true },
  available: () => WeChatIngestPlugin.isEnabled(),
};

describe('wechat tool availability gate', () => {
  it('follows plugin enablement in both directions', () => {
    expect(WeChatIngestPlugin.isEnabled()).toBe(false);
    expect(catalogWith(wechatTool)).toEqual([]);

    enabled.add('wechatIngest');
    expect(WeChatIngestPlugin.isEnabled()).toBe(true);
    expect(catalogWith(wechatTool)).toEqual(['wechat_article_rag']);

    enabled.delete('wechatIngest');
    expect(catalogWith(wechatTool)).toEqual([]);
  });
});
