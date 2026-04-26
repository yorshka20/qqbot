import { describe, expect, test } from 'bun:test';
import type { PersonaRelationship } from '../../epigenetics/types';
import type { MindStateSnapshot } from '../../types';
import {
  buildPromptPatch,
  buildRelationshipSummary,
  DEFAULT_PROMPT_PATCH_THRESHOLDS,
  renderPromptPatchFragment,
} from '../PromptPatchAssembler';

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

  test('relationshipSummary is wrapped in <relationship_state> block', () => {
    const fragment = renderPromptPatchFragment({ relationshipSummary: '对你略有好感' });
    expect(fragment).toContain('<relationship_state>');
    expect(fragment).toContain('</relationship_state>');
    expect(fragment).toContain('对你略有好感');
  });

  test('both moodSummary and relationshipSummary are rendered', () => {
    const fragment = renderPromptPatchFragment({ moodSummary: '你累了', relationshipSummary: '彼此熟悉' });
    expect(fragment).toContain('<mind_state>');
    expect(fragment).toContain('<relationship_state>');
  });
});

// ─── Helper to build a minimal PersonaRelationship ────────────────────────────

function relationship(overrides: Partial<PersonaRelationship> = {}): PersonaRelationship {
  return {
    personaId: 'default',
    userId: 'user1',
    affinity: 0,
    familiarity: 0,
    lastInteractionAt: Date.now(),
    tags: [],
    sharedMemoryRefs: [],
    extra: {},
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('buildRelationshipSummary', () => {
  test('null (first interaction) → contains 首次', () => {
    const summary = buildRelationshipSummary(null);
    expect(summary).toContain('首次');
  });

  test('affinity +0.3, familiarity 0.4 → medium-positive + familiar phrases + numeric values', () => {
    const summary = buildRelationshipSummary(relationship({ affinity: 0.3, familiarity: 0.4 }));
    // Affinity +0.3 is in the [0.1, 0.5) bucket → "好感" phrase
    expect(summary).toContain('好感');
    // Familiarity 0.4 is in the [0.4, 0.7) bucket → "比较熟悉"
    expect(summary).toContain('比较熟悉');
    // Numeric values must be visible
    expect(summary).toContain('+0.30');
    expect(summary).toContain('0.40');
  });

  test('affinity -0.6, familiarity 0.7 → dislike + very-familiar phrases + numeric values', () => {
    const summary = buildRelationshipSummary(relationship({ affinity: -0.6, familiarity: 0.7 }));
    // Affinity -0.6 is in the (<= -0.5) bucket → "反感"
    expect(summary).toContain('反感');
    // Familiarity 0.7 is in the [0.7, 1] bucket → "非常熟悉"
    expect(summary).toContain('非常熟悉');
    // Numeric values must be visible
    expect(summary).toContain('-0.60');
    expect(summary).toContain('0.70');
  });

  test('tags appended as 用户标签：[...]', () => {
    const summary = buildRelationshipSummary(relationship({ tags: ['老粉', '抬杠党'] }));
    expect(summary).toContain('用户标签：[老粉, 抬杠党]');
  });

  test('no tags → tag list absent', () => {
    const summary = buildRelationshipSummary(relationship({ tags: [] }));
    expect(summary).not.toContain('用户标签');
  });

  test('epigenetics behavioral_biases >= 0.1 are appended', () => {
    const epi = {
      personaId: 'default',
      topicMastery: {},
      behavioralBiases: { humor: 0.3, seriousness: -0.2 },
      learnedPreferences: {},
      forbiddenWords: [],
      forbiddenTopics: [],
      traitHistory: [],
      updatedAt: Date.now(),
    };
    const summary = buildRelationshipSummary(relationship(), epi);
    expect(summary).toContain('行为偏差');
    expect(summary).toContain('humor');
  });

  test('epigenetics learnedPreferences keys are appended', () => {
    const epi = {
      personaId: 'default',
      topicMastery: {},
      behavioralBiases: {},
      learnedPreferences: { responseLength: 'short', tone: 'casual' },
      forbiddenWords: [],
      forbiddenTopics: [],
      traitHistory: [],
      updatedAt: Date.now(),
    };
    const summary = buildRelationshipSummary(relationship(), epi);
    expect(summary).toContain('已知偏好');
    expect(summary).toContain('responseLength');
  });
});
