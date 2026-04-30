import { afterEach, describe, expect, test } from 'bun:test';
import { InternalEventBus } from '@/agenda/InternalEventBus';
import { MIND_EVENT_MESSAGE_RECEIVED, MindService } from '../MindService';
import { DEFAULT_MIND_CONFIG, type MindConfig, mergeMindConfig } from '../types';

function service(override: Partial<MindConfig> = {}): { mind: MindService; bus: InternalEventBus } {
  const bus = new InternalEventBus();
  const mind = new MindService({ ...DEFAULT_MIND_CONFIG, ...override, enabled: true }, bus);
  return { mind, bus };
}

describe('MindService — event subscription', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  test('message_received event on bus spikes attention', () => {
    const { mind, bus } = service();
    mind.start();
    cleanups.push(() => mind.stop());

    bus.publish({
      type: MIND_EVENT_MESSAGE_RECEIVED,
      userId: '42',
      groupId: '100',
      botSelfId: 'bot',
      data: { source: 'qq-private' },
    });

    const snap = mind.getSnapshot();
    expect(snap.phenotype.attention).toBeCloseTo(0.3, 5);
    expect(snap.phenotype.stimulusCount).toBe(1);
    expect(snap.phenotype.lastStimulusAt).toBeGreaterThan(0);
  });

  test('unrelated event type is ignored', () => {
    const { mind, bus } = service();
    mind.start();
    cleanups.push(() => mind.stop());

    bus.publish({ type: 'other_event', userId: '1', groupId: '', botSelfId: '' });
    expect(mind.getPhenotype().stimulusCount).toBe(0);
  });

  test('stop() unsubscribes — no further spikes', () => {
    const { mind, bus } = service();
    mind.start();
    bus.publish({
      type: MIND_EVENT_MESSAGE_RECEIVED,
      userId: '1',
      groupId: '',
      botSelfId: '',
      data: { source: 'qq-private' },
    });
    mind.stop();
    bus.publish({
      type: MIND_EVENT_MESSAGE_RECEIVED,
      userId: '1',
      groupId: '',
      botSelfId: '',
      data: { source: 'qq-private' },
    });
    expect(mind.getPhenotype().stimulusCount).toBe(1);
  });

  test('disabled service is a no-op even when start() is called', () => {
    const bus = new InternalEventBus();
    const mind = new MindService({ ...DEFAULT_MIND_CONFIG, enabled: false }, bus);
    mind.start();
    bus.publish({
      type: MIND_EVENT_MESSAGE_RECEIVED,
      userId: '1',
      groupId: '',
      botSelfId: '',
      data: { source: 'qq-private' },
    });
    expect(mind.getPhenotype().stimulusCount).toBe(0);
    mind.stop();
  });

  test('event without applicable source is ignored (e.g. group when applicableSources=[qq-private])', () => {
    const bus = new InternalEventBus();
    const mind = new MindService(
      { ...DEFAULT_MIND_CONFIG, enabled: true, applicableSources: ['qq-private'] },
      bus,
    );
    mind.start();
    cleanups.push(() => mind.stop());
    bus.publish({
      type: MIND_EVENT_MESSAGE_RECEIVED,
      userId: '99',
      groupId: '500',
      botSelfId: 'bot',
      data: { source: 'qq-group' }, // not in allow-list
    });
    expect(mind.getPhenotype().stimulusCount).toBe(0);
  });
});

describe('MindService — snapshot', () => {
  test('snapshot mirrors current phenotype + derived modulation', () => {
    const { mind } = service();
    mind.ingest({ kind: 'message', ts: Date.now() });
    const snap = mind.getSnapshot();
    expect(snap.enabled).toBe(true);
    expect(snap.personaId).toBe('default');
    expect(snap.phenotype.attention).toBeGreaterThan(0);
    expect(snap.modulation.intensityScale).toBeGreaterThan(0);
    expect(snap.modulation.intensityScale).toBeLessThanOrEqual(1);
    expect(snap.capturedAt).toBeGreaterThan(0);
  });

  test('derived modulation reflects fatigue in snapshot', () => {
    const { mind } = service({ modulation: { fatigueIntensityDrop: 0.5, fatigueSpeedDrop: 0.5 } });
    // Force fatigue via tick-style mutation (public ingest doesn't touch fatigue).
    // Use a private escape hatch for the test — cast and mutate.
    (mind as unknown as { phenotype: { fatigue: number } }).phenotype.fatigue = 1;
    const snap = mind.getSnapshot();
    expect(snap.modulation.intensityScale).toBeCloseTo(0.5, 5);
    expect(snap.modulation.speedScale).toBeCloseTo(0.5, 5);
  });
});

describe('MindService — prompt patch', () => {
  test('disabled service returns empty patch + empty fragment', () => {
    const bus = new InternalEventBus();
    const mind = new MindService({ ...DEFAULT_MIND_CONFIG, enabled: false }, bus);
    expect(mind.getPromptPatch()).toEqual({});
    expect(mind.getPromptPatchFragment()).toBe('');
  });

  test('promptPatch.enabled=false suppresses patch even when mind enabled', () => {
    const bus = new InternalEventBus();
    const mind = new MindService(
      {
        ...DEFAULT_MIND_CONFIG,
        enabled: true,
        promptPatch: { ...DEFAULT_MIND_CONFIG.promptPatch, enabled: false },
      },
      bus,
    );
    (mind as unknown as { phenotype: { fatigue: number } }).phenotype.fatigue = 0.9;
    expect(mind.getPromptPatch()).toEqual({});
    expect(mind.getPromptPatchFragment()).toBe('');
  });

  test('high fatigue produces a non-empty fragment wrapped in <mind_state>', () => {
    const { mind } = service();
    (mind as unknown as { phenotype: { fatigue: number } }).phenotype.fatigue = 0.9;
    const fragment = mind.getPromptPatchFragment();
    expect(fragment).toContain('<mind_state>');
    expect(fragment).toContain('非常疲惫');
  });

  test('low fatigue produces no fragment', () => {
    const { mind } = service();
    expect(mind.getPromptPatchFragment()).toBe('');
  });

  test('custom thresholds from config are honored', () => {
    const bus = new InternalEventBus();
    const mind = new MindService(
      {
        ...DEFAULT_MIND_CONFIG,
        enabled: true,
        promptPatch: {
          ...DEFAULT_MIND_CONFIG.promptPatch,
          fatigueSevereMin: 0.4,
        },
      },
      bus,
    );
    (mind as unknown as { phenotype: { fatigue: number } }).phenotype.fatigue = 0.45;
    expect(mind.getPromptPatch().moodSummary).toContain('非常疲惫');
  });
});

describe('mergeMindConfig', () => {
  test('undefined input returns defaults (disabled)', () => {
    const c = mergeMindConfig(undefined);
    expect(c.enabled).toBe(false);
    expect(c.personaId).toBe('default');
    expect(c.tickMs).toBe(1000);
  });

  test('partial input overlays onto defaults', () => {
    const c = mergeMindConfig({ enabled: true, tickMs: 500 });
    expect(c.enabled).toBe(true);
    expect(c.tickMs).toBe(500);
    expect(c.personaId).toBe('default');
  });

  test('nested ode overlays shallow-merge', () => {
    const c = mergeMindConfig({ ode: { tauAttentionMs: 60_000 } });
    expect(c.ode.tauAttentionMs).toBe(60_000);
    // Other ode fields fall back to defaults
    expect(c.ode.attentionSpikePerMessage).toBe(DEFAULT_MIND_CONFIG.ode.attentionSpikePerMessage);
  });

  test('invalid types fall back to defaults', () => {
    const c = mergeMindConfig({ tickMs: 'not-a-number' as unknown as number });
    expect(c.tickMs).toBe(DEFAULT_MIND_CONFIG.tickMs);
  });

  test('promptPatch section defaults to enabled + default thresholds', () => {
    const c = mergeMindConfig({});
    expect(c.promptPatch.enabled).toBe(true);
    expect(c.promptPatch.fatigueMildMin).toBe(DEFAULT_MIND_CONFIG.promptPatch.fatigueMildMin);
  });

  test('promptPatch partial override merges over defaults', () => {
    const c = mergeMindConfig({ promptPatch: { enabled: false } });
    expect(c.promptPatch.enabled).toBe(false);
    expect(c.promptPatch.fatigueSevereMin).toBe(DEFAULT_MIND_CONFIG.promptPatch.fatigueSevereMin);
  });
});
