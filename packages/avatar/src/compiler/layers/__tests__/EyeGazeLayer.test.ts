import { describe, expect, test } from 'bun:test';
import type { AvatarActivity } from '../../../state/types';
import { EyeGazeLayer } from '../EyeGazeLayer';

const ACTIVITY: AvatarActivity = { pose: 'neutral', ambientGain: 1 };

describe('EyeGazeLayer.setGazeTarget', () => {
  test('named camera → sample returns {x:0, y:0}', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'named', name: 'camera' });
    const result = layer.sample(1000, ACTIVITY);
    expect(result).toEqual({ 'eye.ball.x': 0, 'eye.ball.y': 0 });
  });

  test('named left → sample returns {x:-0.7, y:0}', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'named', name: 'left' });
    const result = layer.sample(1000, ACTIVITY);
    expect(result).toEqual({ 'eye.ball.x': -0.7, 'eye.ball.y': 0 });
  });

  test('named right → sample returns {x:0.7, y:0}', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'named', name: 'right' });
    const result = layer.sample(1000, ACTIVITY);
    expect(result).toEqual({ 'eye.ball.x': 0.7, 'eye.ball.y': 0 });
  });

  test('named up → sample returns {x:0, y:-0.7}', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'named', name: 'up' });
    const result = layer.sample(1000, ACTIVITY);
    expect(result).toEqual({ 'eye.ball.x': 0, 'eye.ball.y': -0.7 });
  });

  test('named down → sample returns {x:0, y:0.7}', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'named', name: 'down' });
    const result = layer.sample(1000, ACTIVITY);
    expect(result).toEqual({ 'eye.ball.x': 0, 'eye.ball.y': 0.7 });
  });

  test('point target → sample returns exact clamped values', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'point', x: 0.3, y: -0.2 });
    const result = layer.sample(1000, ACTIVITY);
    expect(result).toEqual({ 'eye.ball.x': 0.3, 'eye.ball.y': -0.2 });
  });

  test('point out-of-range is clamped to [-1, 1]', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'point', x: 5, y: -5 });
    const result = layer.sample(1000, ACTIVITY);
    expect(result).toEqual({ 'eye.ball.x': 1, 'eye.ball.y': -1 });
  });

  test('setGazeTarget(null) after override restores OU path (two samples differ)', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'named', name: 'camera' });
    layer.sample(1000, ACTIVITY); // activate override
    layer.setGazeTarget(null);

    // With OU active the two calls should (eventually) differ.
    // We try up to 5 pairs to absorb the tiny chance of identical noise.
    let found = false;
    let t = 2000;
    for (let i = 0; i < 5; i++) {
      const a = layer.sample(t, ACTIVITY);
      t += 16;
      const b = layer.sample(t, ACTIVITY);
      t += 16;
      if (a['eye.ball.x'] !== b['eye.ball.x'] || a['eye.ball.y'] !== b['eye.ball.y']) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  test('reset() after override clears override (OU resumes)', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'named', name: 'right' });
    layer.sample(1000, ACTIVITY);
    layer.reset();

    let found = false;
    let t = 2000;
    for (let i = 0; i < 5; i++) {
      const a = layer.sample(t, ACTIVITY);
      t += 16;
      const b = layer.sample(t, ACTIVITY);
      t += 16;
      if (a['eye.ball.x'] !== b['eye.ball.x'] || a['eye.ball.y'] !== b['eye.ball.y']) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  test('clear type restores OU path', () => {
    const layer = new EyeGazeLayer();
    layer.setGazeTarget({ type: 'named', name: 'left' });
    layer.sample(1000, ACTIVITY);
    layer.setGazeTarget({ type: 'clear' });

    let found = false;
    let t = 2000;
    for (let i = 0; i < 5; i++) {
      const a = layer.sample(t, ACTIVITY);
      t += 16;
      const b = layer.sample(t, ACTIVITY);
      t += 16;
      if (a['eye.ball.x'] !== b['eye.ball.x'] || a['eye.ball.y'] !== b['eye.ball.y']) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});
