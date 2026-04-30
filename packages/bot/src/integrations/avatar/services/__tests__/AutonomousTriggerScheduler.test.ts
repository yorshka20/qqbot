import { describe, expect, mock, test } from 'bun:test';
import { DEFAULT_PERSONA_CONFIG } from '@/persona/types';
import { AutonomousTriggerScheduler } from '../AutonomousTriggerScheduler';

interface FakePhenotype {
  fatigue: number;
  attention: number;
  stimulusCount: number;
  valence?: number;
}

function freshFakePhenotype(overrides: Partial<FakePhenotype> = {}): FakePhenotype {
  return { fatigue: 0, attention: 0, stimulusCount: 0, ...overrides };
}

interface Harness {
  scheduler: AutonomousTriggerScheduler;
  phenotypeRef: { current: FakePhenotype };
  clockRef: { current: number };
  consumerRef: { present: boolean };
  enqueueAutonomous: ReturnType<typeof mock>;
  enqueueAutonomousEmotion: ReturnType<typeof mock>;
  advance(ms: number): void;
}

function makeHarness(opts?: {
  configOverrides?: Partial<typeof DEFAULT_PERSONA_CONFIG.autonomousTrigger>;
  randomQueue?: number[];
  consumerPresent?: boolean;
}): Harness {
  const phenotypeRef = { current: freshFakePhenotype() };
  const clockRef = { current: 0 };
  const consumerRef = { present: opts?.consumerPresent ?? true };
  const enqueueAutonomous = mock<
    (name: string, intensity: number, opts?: { emotion?: string; durationOverrideMs?: number }) => void
  >(() => {});
  const enqueueAutonomousEmotion = mock<(name: string, intensity: number) => void>(() => {});

  const queue = opts?.randomQueue ? [...opts.randomQueue] : null;
  const random = (): number => {
    if (queue && queue.length > 0) return queue.shift() as number;
    return 0.5;
  };

  const config = {
    ...DEFAULT_PERSONA_CONFIG.autonomousTrigger,
    ...opts?.configOverrides,
  };

  const scheduler = new AutonomousTriggerScheduler(config, {
    persona: { getPhenotype: () => phenotypeRef.current as never },
    avatar: {
      enqueueAutonomous: enqueueAutonomous as never,
      enqueueAutonomousEmotion: enqueueAutonomousEmotion as never,
      hasConsumer: () => consumerRef.present,
    },
    now: () => clockRef.current,
    random,
  });

  return {
    scheduler,
    phenotypeRef,
    clockRef,
    consumerRef,
    enqueueAutonomous,
    enqueueAutonomousEmotion,
    advance(ms: number) {
      clockRef.current += ms;
    },
  };
}

describe('AutonomousTriggerScheduler — fatigue yawn', () => {
  test('fires when fatigue > threshold and cooldown elapsed', () => {
    // randomQueue [0.0] → first sampleYawnCooldown returns exactly 5 min
    const h = makeHarness({ randomQueue: [0.0] });
    h.phenotypeRef.current = freshFakePhenotype({ fatigue: 0.85 });
    // Initial tick at t=0 — lastYawnAt is null so it fires immediately
    // — but the ticket says the FIRST yawn should respect a "warm-up"?
    // Re-read: ticket only specifies cooldown between consecutive fires.
    // First fire is unconditional once threshold is exceeded — adjust if
    // implementation differs. With this implementation, first call at t=0
    // is allowed because lastYawnAt is null.
    h.scheduler.tick();
    expect(h.enqueueAutonomous).toHaveBeenCalledTimes(1);
    expect(h.enqueueAutonomous.mock.calls[0]).toEqual(['vrm_emotion_refresh', 0.6]);
  });

  test('cooldown blocks second fire within window', () => {
    // First sample 5 min (random=0.0), second sample 10 min (random=1.0)
    const h = makeHarness({ randomQueue: [0.0, 1.0] });
    h.phenotypeRef.current = freshFakePhenotype({ fatigue: 0.85 });
    h.scheduler.tick(); // fires at t=0
    expect(h.enqueueAutonomous).toHaveBeenCalledTimes(1);

    h.advance(4 * 60_000); // t=4min, still within 5min cooldown
    h.scheduler.tick();
    expect(h.enqueueAutonomous).toHaveBeenCalledTimes(1);

    h.advance(2 * 60_000); // t=6min, past 5min cooldown
    h.scheduler.tick();
    expect(h.enqueueAutonomous).toHaveBeenCalledTimes(2);

    // After second fire, next cooldown sampled at random=1.0 → 10min
    h.advance(8 * 60_000); // t=14min, only 8min since last fire — blocked
    h.scheduler.tick();
    expect(h.enqueueAutonomous).toHaveBeenCalledTimes(2);

    h.advance(3 * 60_000); // t=17min, 11min since last fire — fires
    h.scheduler.tick();
    expect(h.enqueueAutonomous).toHaveBeenCalledTimes(3);
  });

  test('fatigue below threshold never fires', () => {
    const h = makeHarness();
    h.phenotypeRef.current = freshFakePhenotype({ fatigue: 0.7 });
    for (let i = 0; i < 10; i++) {
      h.advance(60_000);
      h.scheduler.tick();
    }
    expect(h.enqueueAutonomous).not.toHaveBeenCalled();
  });
});

describe('AutonomousTriggerScheduler — valence drift', () => {
  test('negative drift enqueues sad once', () => {
    const h = makeHarness();
    h.phenotypeRef.current = freshFakePhenotype({ valence: 0 });
    h.scheduler.tick();
    expect(h.enqueueAutonomousEmotion).not.toHaveBeenCalled();

    h.phenotypeRef.current = freshFakePhenotype({ valence: -0.4 });
    h.scheduler.tick();
    expect(h.enqueueAutonomousEmotion).toHaveBeenCalledTimes(1);
    const [name, intensity] = h.enqueueAutonomousEmotion.mock.calls[0];
    expect(name).toBe('emotion_sad');
    expect(intensity).toBeCloseTo(0.24, 5); // clamp(0.4*0.6, 0.2, 0.5)

    // Persisting same valence — no re-enqueue
    h.scheduler.tick();
    expect(h.enqueueAutonomousEmotion).toHaveBeenCalledTimes(1);
  });

  test('positive drift enqueues smile once', () => {
    const h = makeHarness();
    h.phenotypeRef.current = freshFakePhenotype({ valence: 0.6 });
    h.scheduler.tick();
    expect(h.enqueueAutonomousEmotion).toHaveBeenCalledTimes(1);
    const [name, intensity] = h.enqueueAutonomousEmotion.mock.calls[0];
    expect(name).toBe('emotion_smile');
    expect(intensity).toBeCloseTo(0.3, 5); // clamp(0.6*0.5, 0.3, 0.6)
  });

  test('return-to-neutral after drift releases with thinking@0', () => {
    const h = makeHarness();
    h.phenotypeRef.current = freshFakePhenotype({ valence: -0.4 });
    h.scheduler.tick(); // sad call
    h.phenotypeRef.current = freshFakePhenotype({ valence: 0.0 });
    h.scheduler.tick(); // neutral release
    expect(h.enqueueAutonomousEmotion).toHaveBeenCalledTimes(2);
    expect(h.enqueueAutonomousEmotion.mock.calls[1]).toEqual(['emotion_thinking', 0]);
  });

  test('hysteresis dead-band — wobble does not enqueue', () => {
    const h = makeHarness();
    // First cross into sad
    h.phenotypeRef.current = freshFakePhenotype({ valence: -0.4 });
    h.scheduler.tick();
    expect(h.enqueueAutonomousEmotion).toHaveBeenCalledTimes(1);

    // Wobble inside the dead-band [-0.3, -0.1)
    for (const v of [-0.2, -0.4, -0.2, -0.4, -0.2]) {
      h.phenotypeRef.current = freshFakePhenotype({ valence: v });
      h.scheduler.tick();
    }
    expect(h.enqueueAutonomousEmotion).toHaveBeenCalledTimes(1); // still just the original sad call
  });
});

describe('AutonomousTriggerScheduler — disabled config', () => {
  test('enabled=false makes tick() and start() inert', () => {
    const h = makeHarness({ configOverrides: { enabled: false } });
    h.phenotypeRef.current = freshFakePhenotype({ fatigue: 0.95, valence: -0.6 });
    h.scheduler.start(); // should not start a timer
    for (let i = 0; i < 10; i++) {
      h.advance(60_000);
      h.scheduler.tick();
    }
    expect(h.enqueueAutonomous).not.toHaveBeenCalled();
    expect(h.enqueueAutonomousEmotion).not.toHaveBeenCalled();
    h.scheduler.stop();
  });
});

describe('AutonomousTriggerScheduler — no-consumer gate', () => {
  test('tick() skips work when no renderer / VTS consumer connected', () => {
    const h = makeHarness({ consumerPresent: false });
    h.phenotypeRef.current = freshFakePhenotype({ fatigue: 0.95, valence: -0.6 });
    h.scheduler.tick();
    expect(h.enqueueAutonomous).not.toHaveBeenCalled();
    expect(h.enqueueAutonomousEmotion).not.toHaveBeenCalled();
    // Reconnect → next tick processes phenotype as usual.
    h.consumerRef.present = true;
    h.scheduler.tick();
    expect(h.enqueueAutonomous).toHaveBeenCalledTimes(1);
    expect(h.enqueueAutonomousEmotion).toHaveBeenCalledTimes(1);
  });
});
