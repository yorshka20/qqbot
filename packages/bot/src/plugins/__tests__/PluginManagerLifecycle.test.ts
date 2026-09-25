import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import type { PluginManagerDeps } from '../PluginManager';
import { PluginManager } from '../PluginManager';
import type { Plugin } from '../types';

function createPlugin(name: string, log: string[]): Plugin {
  return {
    name,
    version: '1.0.0',
    loadConfig: () => {},
    onEnable: () => {
      log.push(`${name}:enable`);
    },
    onDisable: () => {
      log.push(`${name}:disable`);
    },
    onStart: () => {
      log.push(`${name}:start`);
    },
    onStop: () => {
      log.push(`${name}:stop`);
    },
  };
}

function createManager(plugins: Plugin[]): PluginManager {
  const manager = new PluginManager({} as PluginManagerDeps);
  const registry = (manager as unknown as { plugins: Map<string, Plugin> }).plugins;
  for (const plugin of plugins) {
    registry.set(plugin.name, plugin);
  }
  return manager;
}

describe('PluginManager start/stop lifecycle', () => {
  it('starts only enabled plugins and stops them in reverse order', async () => {
    const log: string[] = [];
    const manager = createManager([createPlugin('a', log), createPlugin('b', log), createPlugin('off', log)]);
    await manager.enablePlugin('a');
    await manager.enablePlugin('b');

    await manager.startAll();
    await manager.stopAll();

    expect(log).toEqual(['a:enable', 'b:enable', 'a:start', 'b:start', 'b:stop', 'a:stop']);
  });

  it('does not start a plugin enabled before the app is running', async () => {
    const log: string[] = [];
    const manager = createManager([createPlugin('a', log)]);

    await manager.enablePlugin('a');

    expect(log).toEqual(['a:enable']);
  });

  it('starts a plugin enabled while running and stops it before onDisable', async () => {
    const log: string[] = [];
    const manager = createManager([createPlugin('a', log)]);
    await manager.startAll();

    await manager.enablePlugin('a');
    await manager.disablePlugin('a');

    expect(log).toEqual(['a:enable', 'a:start', 'a:stop', 'a:disable']);
  });

  it('keeps starting the remaining plugins when one onStart throws', async () => {
    const log: string[] = [];
    const broken = createPlugin('broken', log);
    broken.onStart = () => {
      throw new Error('boom');
    };
    const manager = createManager([broken, createPlugin('ok', log)]);
    await manager.enablePlugin('broken');
    await manager.enablePlugin('ok');

    await manager.startAll();
    await manager.stopAll();

    expect(log).toEqual(['broken:enable', 'ok:enable', 'ok:start', 'ok:stop']);
  });
});
