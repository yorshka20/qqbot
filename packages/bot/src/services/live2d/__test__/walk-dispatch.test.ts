// Focused unit tests for walk-tag vector-merge in dispatchTags().
//
// These tests exercise the batch dispatcher directly, without involving stages
// or a DI container. The goal is to verify that consecutive [W:forward],
// [W:strafe], and [W:turn] tags are merged into one walkRelative() call, while
// non-mergeable walk types and non-walk tags each flush the buffer first.

import 'reflect-metadata';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { parseRichTags } from '@qqbot/avatar';
import { dispatchTags } from '../dispatchParsedTag';
import { createContext } from '../Live2DStage';
import type { Live2DInput } from '../types';

function sampleInput(overrides?: Partial<Live2DInput>): Live2DInput {
  return { text: 'hello', source: 'avatar-cmd', ...overrides };
}

/** Minimal fake avatar that only tracks walk-related calls. */
function makeWalkAvatar() {
  return {
    walkRelativeCalls: [] as Array<{ forwardM: number; strafeM: number; turnRad: number }>,
    walkToSemanticCalls: [] as string[],
    orbitCalls: [] as unknown[],
    stopMotionCalled: 0,
    enqueued: [] as unknown[],
    emotioned: [] as unknown[],
    gazed: [] as unknown[],

    walkRelative: mock(function (this: ReturnType<typeof makeWalkAvatar>, forwardM: number, strafeM: number, turnRad: number): Promise<void> {
      this.walkRelativeCalls.push({ forwardM, strafeM, turnRad });
      return Promise.resolve();
    }),
    walkForward: mock(function (): Promise<void> {
      // Should never be called — dispatchTags routes into walkRelative.
      return Promise.resolve();
    }),
    strafe: mock(function (): Promise<void> {
      return Promise.resolve();
    }),
    turn: mock(function (): Promise<void> {
      return Promise.resolve();
    }),
    walkToSemantic: mock(function (this: ReturnType<typeof makeWalkAvatar>, target: string): Promise<void> {
      this.walkToSemanticCalls.push(target);
      return Promise.resolve();
    }),
    faceSemantic: mock(function (): Promise<void> {
      return Promise.resolve();
    }),
    orbit: mock(function (this: ReturnType<typeof makeWalkAvatar>, opts: unknown): Promise<void> {
      this.orbitCalls.push(opts);
      return Promise.resolve();
    }),
    stopMotion: mock(function (this: ReturnType<typeof makeWalkAvatar>): void {
      this.stopMotionCalled++;
    }),
    enqueueTagAnimation: mock(function (this: ReturnType<typeof makeWalkAvatar>, t: unknown): void {
      this.enqueued.push(t);
    }),
    enqueueEmotion: mock(function (this: ReturnType<typeof makeWalkAvatar>, _name: string, _intensity: number): void {
      this.emotioned.push({ _name, _intensity });
    }),
    setGazeTarget: mock(function (this: ReturnType<typeof makeWalkAvatar>, target: unknown): void {
      this.gazed.push(target);
    }),
    getActionDuration: mock((_action: string) => undefined as number | undefined),
  };
}

describe('dispatchTags — walk vector-merge', () => {
  let avatar: ReturnType<typeof makeWalkAvatar>;

  beforeEach(() => {
    avatar = makeWalkAvatar();
  });

  it('[W:forward:1.5][W:strafe:0.3] => one combined walkRelative call (diagonal merge)', () => {
    const tags = parseRichTags('[W:forward:1.5][W:strafe:0.3]');
    const ctx = createContext(sampleInput());
    dispatchTags(tags, ctx, avatar as never);

    expect(avatar.walkRelativeCalls).toHaveLength(1);
    expect(avatar.walkRelativeCalls[0].forwardM).toBeCloseTo(1.5);
    expect(avatar.walkRelativeCalls[0].strafeM).toBeCloseTo(0.3);
    expect(avatar.walkRelativeCalls[0].turnRad).toBeCloseTo(0);
    expect(avatar.walkForward).not.toHaveBeenCalled();
    expect(avatar.strafe).not.toHaveBeenCalled();
  });

  it('[W:forward:1.0][W:turn:30] => one combined walkRelative call (translation + facing delta)', () => {
    const tags = parseRichTags('[W:forward:1.0][W:turn:30]');
    const ctx = createContext(sampleInput());
    dispatchTags(tags, ctx, avatar as never);

    expect(avatar.walkRelativeCalls).toHaveLength(1);
    expect(avatar.walkRelativeCalls[0].forwardM).toBeCloseTo(1.0);
    expect(avatar.walkRelativeCalls[0].strafeM).toBeCloseTo(0);
    expect(avatar.walkRelativeCalls[0].turnRad).toBeCloseTo((30 * Math.PI) / 180);
    expect(avatar.turn).not.toHaveBeenCalled();
  });

  it('[W:forward:1.0][A:vrm_greet_wave][W:strafe:0.3] => forward flush, action enqueue, then strafe flush (order verified)', () => {
    // Track dispatch order explicitly so the test proves the sequencing contract,
    // not only the call counts.
    const dispatchOrder: string[] = [];

    avatar.walkRelative = mock(function (this: typeof avatar, forwardM: number, strafeM: number, turnRad: number) {
      this.walkRelativeCalls.push({ forwardM, strafeM, turnRad });
      dispatchOrder.push(`walkRelative(${forwardM.toFixed(1)},${strafeM.toFixed(1)},${turnRad.toFixed(1)})`);
      return Promise.resolve();
    });
    avatar.enqueueTagAnimation = mock(function (this: typeof avatar, t: unknown) {
      this.enqueued.push(t);
      dispatchOrder.push(`enqueue(${(t as { action: string }).action})`);
    });

    const tags = parseRichTags('[W:forward:1.0][A:vrm_greet_wave][W:strafe:0.3]');
    const ctx = createContext(sampleInput());
    dispatchTags(tags, ctx, avatar as never);

    // Two separate walkRelative calls: one for forward, one for strafe.
    expect(avatar.walkRelativeCalls).toHaveLength(2);
    expect(avatar.walkRelativeCalls[0].forwardM).toBeCloseTo(1.0);
    expect(avatar.walkRelativeCalls[0].strafeM).toBeCloseTo(0);
    expect(avatar.walkRelativeCalls[1].forwardM).toBeCloseTo(0);
    expect(avatar.walkRelativeCalls[1].strafeM).toBeCloseTo(0.3);
    // Action was enqueued between the two walks.
    expect(avatar.enqueued).toHaveLength(1);
    expect((avatar.enqueued[0] as { action: string }).action).toBe('vrm_greet_wave');
    // Explicit dispatch order: walk → action → walk.
    expect(dispatchOrder).toEqual([
      'walkRelative(1.0,0.0,0.0)',
      'enqueue(vrm_greet_wave)',
      'walkRelative(0.0,0.3,0.0)',
    ]);
  });

  it('[W:forward:1.0][W:to:camera] => flush forward first, then separate semantic walk', () => {
    const tags = parseRichTags('[W:forward:1.0][W:to:camera]');
    const ctx = createContext(sampleInput());
    dispatchTags(tags, ctx, avatar as never);

    expect(avatar.walkRelativeCalls).toHaveLength(1);
    expect(avatar.walkRelativeCalls[0].forwardM).toBeCloseTo(1.0);
    expect(avatar.walkToSemanticCalls).toHaveLength(1);
    expect(avatar.walkToSemanticCalls[0]).toBe('camera');
  });

  it('[W:forward:1.0][W:orbit:90] => flush forward first, then separate orbit', () => {
    const tags = parseRichTags('[W:forward:1.0][W:orbit:90]');
    const ctx = createContext(sampleInput());
    dispatchTags(tags, ctx, avatar as never);

    expect(avatar.walkRelativeCalls).toHaveLength(1);
    expect(avatar.walkRelativeCalls[0].forwardM).toBeCloseTo(1.0);
    expect(avatar.orbitCalls).toHaveLength(1);
    const orbitOpts = avatar.orbitCalls[0] as { sweepRad: number };
    expect(orbitOpts.sweepRad).toBeCloseTo((90 * Math.PI) / 180);
  });

  it('[W:forward:1.0][W:stop] => flush forward first, then stopMotion', () => {
    const tags = parseRichTags('[W:forward:1.0][W:stop]');
    const ctx = createContext(sampleInput());
    dispatchTags(tags, ctx, avatar as never);

    expect(avatar.walkRelativeCalls).toHaveLength(1);
    expect(avatar.walkRelativeCalls[0].forwardM).toBeCloseTo(1.0);
    expect(avatar.stopMotionCalled).toBe(1);
  });

  it('[W:forward:1.0] => one walkRelative call, unchanged behavior', () => {
    const tags = parseRichTags('[W:forward:1.0]');
    const ctx = createContext(sampleInput());
    dispatchTags(tags, ctx, avatar as never);

    expect(avatar.walkRelativeCalls).toHaveLength(1);
    expect(avatar.walkRelativeCalls[0].forwardM).toBeCloseTo(1.0);
    expect(avatar.walkRelativeCalls[0].strafeM).toBeCloseTo(0);
    expect(avatar.walkRelativeCalls[0].turnRad).toBeCloseTo(0);
  });

  it('[A:vrm_greet_wave] => zero walk calls', () => {
    const tags = parseRichTags('[A:vrm_greet_wave]');
    const ctx = createContext(sampleInput());
    dispatchTags(tags, ctx, avatar as never);

    expect(avatar.walkRelativeCalls).toHaveLength(0);
    expect(avatar.enqueued).toHaveLength(1);
  });

  it('[W:turn:0] => zero walk calls (zero-magnitude buffer is not flushed)', () => {
    const tags = parseRichTags('[W:turn:0]');
    const ctx = createContext(sampleInput());
    dispatchTags(tags, ctx, avatar as never);

    expect(avatar.walkRelativeCalls).toHaveLength(0);
    expect(avatar.turn).not.toHaveBeenCalled();
  });

  it('two streaming chunks (chunk1=[W:forward:1.0], chunk2=[W:strafe:0.3]) => two separate walk calls (no cross-chunk merge)', () => {
    const ctx = createContext(sampleInput());

    // Simulates streaming: each chunk is dispatched independently.
    const chunk1Tags = parseRichTags('[W:forward:1.0]');
    dispatchTags(chunk1Tags, ctx, avatar as never);

    const chunk2Tags = parseRichTags('[W:strafe:0.3]');
    dispatchTags(chunk2Tags, ctx, avatar as never);

    // Each chunk flushes its own local buffer at the end of the call.
    expect(avatar.walkRelativeCalls).toHaveLength(2);
    expect(avatar.walkRelativeCalls[0].forwardM).toBeCloseTo(1.0);
    expect(avatar.walkRelativeCalls[0].strafeM).toBeCloseTo(0);
    expect(avatar.walkRelativeCalls[1].forwardM).toBeCloseTo(0);
    expect(avatar.walkRelativeCalls[1].strafeM).toBeCloseTo(0.3);
  });
});
