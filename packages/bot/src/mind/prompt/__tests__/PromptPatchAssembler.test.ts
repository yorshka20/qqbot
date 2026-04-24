import { describe, expect, test } from 'bun:test';
import type { MindStateSnapshot } from '../../types';
import { buildPromptPatch, DEFAULT_PROMPT_PATCH_THRESHOLDS, renderPromptPatchFragment } from '../PromptPatchAssembler';

function snapshot(overrides: Partial<MindStateSnapshot['phenotype']> = {}, enabled = true): MindStateSnapshot {
  return {
    enabled,
    personaId: 'default',
    phenotype: {
      fatigue: 0,
      attention: 0,
      stimulusCount: 0,
      lastStimulusAt: undefined,
      ...overrides,
    },
    modulation: {
      intensityScale: 1,
      speedScale: 1,
      durationBias: 0,
    },
    capturedAt: 0,
  };
}

describe('buildPromptPatch — fatigue buckets (default thresholds)', () => {
  test('disabled snapshot always returns empty patch', () => {
    expect(buildPromptPatch(snapshot({ fatigue: 0.95 }, /* enabled */ false))).toEqual({});
  });

  test('fatigue below mildMin → empty patch', () => {
    expect(buildPromptPatch(snapshot({ fatigue: 0 }))).toEqual({});
    expect(buildPromptPatch(snapshot({ fatigue: 0.2 }))).toEqual({});
    expect(buildPromptPatch(snapshot({ fatigue: 0.29 }))).toEqual({});
  });

  test('fatigue at mildMin → mild moodSummary', () => {
    const patch = buildPromptPatch(snapshot({ fatigue: 0.3 }));
    expect(patch.moodSummary).toBeDefined();
    expect(patch.moodSummary).toContain('略有些累');
  });

  test('fatigue between mild and moderate → mild moodSummary', () => {
    expect(buildPromptPatch(snapshot({ fatigue: 0.45 })).moodSummary).toContain('略有些累');
  });

  test('fatigue at moderateMin → moderate moodSummary', () => {
    expect(buildPromptPatch(snapshot({ fatigue: 0.55 })).moodSummary).toContain('有些疲倦');
  });

  test('fatigue between moderate and severe → moderate moodSummary', () => {
    expect(buildPromptPatch(snapshot({ fatigue: 0.7 })).moodSummary).toContain('有些疲倦');
  });

  test('fatigue at severeMin → severe moodSummary', () => {
    expect(buildPromptPatch(snapshot({ fatigue: 0.8 })).moodSummary).toContain('非常疲惫');
  });

  test('fatigue clamped: > 1 still severe, < 0 still empty', () => {
    expect(buildPromptPatch(snapshot({ fatigue: 5 })).moodSummary).toContain('非常疲惫');
    expect(buildPromptPatch(snapshot({ fatigue: -1 }))).toEqual({});
  });

  test('non-finite fatigue treated as 0 (empty patch)', () => {
    expect(buildPromptPatch(snapshot({ fatigue: Number.NaN }))).toEqual({});
  });
});

describe('buildPromptPatch — custom thresholds', () => {
  test('raising mildMin suppresses mild bucket', () => {
    const patch = buildPromptPatch(snapshot({ fatigue: 0.4 }), {
      ...DEFAULT_PROMPT_PATCH_THRESHOLDS,
      fatigueMildMin: 0.5,
    });
    expect(patch.moodSummary).toBeUndefined();
  });

  test('lowering severeMin bumps into severe bucket earlier', () => {
    const patch = buildPromptPatch(snapshot({ fatigue: 0.6 }), {
      ...DEFAULT_PROMPT_PATCH_THRESHOLDS,
      fatigueSevereMin: 0.6,
    });
    expect(patch.moodSummary).toContain('非常疲惫');
  });
});

describe('renderPromptPatchFragment', () => {
  test('empty patch renders to empty string', () => {
    expect(renderPromptPatchFragment({})).toBe('');
  });

  test('moodSummary is wrapped in <mind_state> block', () => {
    const fragment = renderPromptPatchFragment({ moodSummary: '你此刻有点累' });
    expect(fragment).toContain('<mind_state>');
    expect(fragment).toContain('</mind_state>');
    expect(fragment).toContain('你此刻有点累');
  });

  test('end-to-end: snapshot → patch → fragment for severe fatigue', () => {
    const fragment = renderPromptPatchFragment(buildPromptPatch(snapshot({ fatigue: 0.9 })));
    expect(fragment).toContain('<mind_state>');
    expect(fragment).toContain('非常疲惫');
  });

  test('end-to-end: low fatigue → no fragment injected', () => {
    expect(renderPromptPatchFragment(buildPromptPatch(snapshot({ fatigue: 0.1 })))).toBe('');
  });
});
