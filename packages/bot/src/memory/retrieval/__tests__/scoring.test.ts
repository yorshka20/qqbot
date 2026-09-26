import { describe, expect, it } from 'bun:test';
import { scoreFact } from '../scoring';

const DAY = 86_400_000;
const SCORING = { transientHalfLifeDays: 30, decayFloor: 0.5, confirmBoostPerConfirm: 0.03, confirmBoostCap: 1.3 };

describe('scoreFact', () => {
  const now = 100 * DAY;

  it('does not decay stable facts', () => {
    expect(scoreFact(0.6, { durability: 'stable', lastConfirmedAt: 0, confirmCount: 1 }, SCORING, now)).toBeCloseTo(0.6);
  });

  it('halves a transient fact per half-life, down to the floor', () => {
    const at = (days: number) => now - days * DAY;
    expect(
      scoreFact(0.6, { durability: 'transient', lastConfirmedAt: at(15), confirmCount: 1 }, SCORING, now),
    ).toBeCloseTo(0.6 * 2 ** -0.5);
    expect(
      scoreFact(0.6, { durability: 'transient', lastConfirmedAt: at(300), confirmCount: 1 }, SCORING, now),
    ).toBeCloseTo(0.3);
  });

  it('adds weight per confirmation, capped', () => {
    expect(scoreFact(0.5, { durability: 'stable', lastConfirmedAt: now, confirmCount: 3 }, SCORING, now)).toBeCloseTo(
      0.53,
    );
    expect(scoreFact(0.5, { durability: 'stable', lastConfirmedAt: now, confirmCount: 50 }, SCORING, now)).toBeCloseTo(
      0.65,
    );
  });
});
