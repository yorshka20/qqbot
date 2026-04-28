import { describe, expect, it } from 'bun:test';
import { AmbientGainBus } from '../compiler/AmbientGainBus';

describe('AmbientGainBus', () => {
  it('empty bus starts at fallback (1.0) and stays there after tick', () => {
    const bus = new AmbientGainBus();
    expect(bus.snapshot().resolved).toBe(1.0);
    bus.tick(1000);
    expect(bus.snapshot().resolved).toBe(1.0);
  });

  it('single source converges toward set value', () => {
    const bus = new AmbientGainBus();
    bus.setSource('activity', 0.3);
    for (let i = 0; i < 12; i++) {
      bus.tick(1000);
    }
    expect(Math.abs(bus.snapshot().resolved - 0.3)).toBeLessThan(1e-3);
  });

  it('three sources reduced with min', () => {
    const bus = new AmbientGainBus();
    bus.setSource('idle', 1.0);
    bus.setSource('mind', 0.7);
    bus.setSource('activity', 0.3);
    for (let i = 0; i < 12; i++) {
      bus.tick(1000);
    }
    // resolved should converge toward 0.3 (min of all three)
    expect(Math.abs(bus.snapshot().resolved - 0.3)).toBeLessThan(1e-3);
  });

  it('step input monotonic decrease', () => {
    const bus = new AmbientGainBus();
    bus.setSource('activity', 1.0);
    // One large tick to converge to 1.0
    bus.tick(10000);
    expect(Math.abs(bus.snapshot().resolved - 1.0)).toBeLessThan(0.02);

    // Drop to 0
    bus.setSource('activity', 0.0);
    // tick(0) should not change the value
    const afterZeroTick = bus.tick(0);
    expect(afterZeroTick).toBeCloseTo(1.0, 5);

    // Each tick(1000) should decrease monotonically
    let prev = afterZeroTick;
    for (let i = 0; i < 10; i++) {
      const curr = bus.tick(1000);
      expect(curr).toBeLessThan(prev);
      expect(curr).toBeGreaterThanOrEqual(0);
      prev = curr;
    }
    // After 10 ticks of 1000ms with tau=1000, resolved should be very close to 0
    // alpha per tick = 1000/(1000+1000) = 0.5, so after 10 ticks: 1.0 * 0.5^10 ≈ 0.00098
    expect(bus.snapshot().resolved).toBeLessThan(1e-3);
  });

  it('NaN rejected — source not set', () => {
    const bus = new AmbientGainBus();
    bus.setSource('mind', NaN);
    // source should not be set
    expect('mind' in bus.snapshot().sources).toBe(false);
  });

  it('Infinity rejected — source not set', () => {
    const bus = new AmbientGainBus();
    bus.setSource('mind', Infinity);
    expect('mind' in bus.snapshot().sources).toBe(false);
  });

  it('negative value clamped to 0', () => {
    const bus = new AmbientGainBus();
    bus.setSource('mind', -1);
    expect(bus.snapshot().sources.mind).toBe(0);
  });

  it('clearSource removes from reduction', () => {
    const bus = new AmbientGainBus();
    bus.setSource('activity', 0.3);
    bus.setSource('mind', 0.5);
    bus.clearSource('activity');
    // Converge toward 0.5
    for (let i = 0; i < 12; i++) {
      bus.tick(1000);
    }
    expect(Math.abs(bus.snapshot().resolved - 0.5)).toBeLessThan(1e-3);
  });

  it('custom reducer (max)', () => {
    const bus = new AmbientGainBus({ reducer: (vs) => Math.max(...vs) });
    bus.setSource('idle', 0.3);
    bus.setSource('mind', 0.5);
    bus.setSource('activity', 0.8);
    for (let i = 0; i < 12; i++) {
      bus.tick(1000);
    }
    expect(Math.abs(bus.snapshot().resolved - 0.8)).toBeLessThan(1e-3);
  });

  it('tick(0) no-op — value unchanged', () => {
    const bus = new AmbientGainBus();
    bus.setSource('activity', 0.3);
    const returned = bus.tick(0);
    expect(returned).toBe(1.0); // initial smoothed
    expect(bus.snapshot().resolved).toBe(1.0);
  });
});
