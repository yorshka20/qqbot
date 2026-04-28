import { describe, expect, test } from 'bun:test';
import { type CharacterBible, EMPTY_BIBLE } from '@/mind/personaStore/CharacterBibleLoader';
import type { MindStateSnapshot } from '@/mind/types';
import {
  buildPersonaBoundariesFragment,
  buildPersonaIdentityFragment,
  buildPromptPatchAsync,
  renderPromptPatchFragment,
} from '../prompt/PromptPatchAssembler';

function makeBible(overrides: Partial<CharacterBible> = {}): CharacterBible {
  return {
    selfConcept: '我是默认人格...',
    voice: '我说话语气中等...',
    triggersRaw: '触发器表...',
    reflexesRaw: '反射条目...',
    boundaries: '我不假装是真人...',
    lore: '我出生于 2026 年的 qqbot...',
    raw: '# Default ...',
    ...overrides,
  };
}

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

// ─── Test 1: Gate off ─────────────────────────────────────────────────────────

describe('bible injection — gate off (injectBible: false)', () => {
  test('full bible + injectBible=false → no persona blocks in rendered fragment', async () => {
    const patch = await buildPromptPatchAsync(snapshot(), {
      bible: makeBible(),
      injectBible: false,
      bibleMaxCharsPerSection: 800,
    });
    const fragment = renderPromptPatchFragment(patch);
    expect(fragment).not.toContain('<persona_identity>');
    expect(fragment).not.toContain('<persona_boundaries>');
    expect(patch.personaIdentity).toBeUndefined();
    expect(patch.personaBoundaries).toBeUndefined();
  });
});

// ─── Test 2: Empty bible gate ─────────────────────────────────────────────────

describe('bible injection — empty bible gate', () => {
  test('injectBible=true + EMPTY_BIBLE → no persona blocks emitted', async () => {
    const patch = await buildPromptPatchAsync(snapshot(), {
      bible: EMPTY_BIBLE,
      injectBible: true,
      bibleMaxCharsPerSection: 800,
    });
    const fragment = renderPromptPatchFragment(patch);
    expect(fragment).not.toContain('<persona_identity>');
    expect(fragment).not.toContain('<persona_boundaries>');
    expect(patch.personaIdentity).toBeUndefined();
    expect(patch.personaBoundaries).toBeUndefined();
  });
});

// ─── Test 3: Happy path ───────────────────────────────────────────────────────

describe('bible injection — happy path', () => {
  test('both blocks emitted; render order: identity < boundaries < mind_state', async () => {
    // Use high fatigue to also generate moodSummary so we can assert order vs <mind_state>
    const patch = await buildPromptPatchAsync(snapshot({ fatigue: 0.9 }), {
      bible: makeBible(),
      injectBible: true,
      bibleMaxCharsPerSection: 800,
    });

    expect(patch.personaIdentity).toBeDefined();
    expect(patch.personaBoundaries).toBeDefined();

    // personaIdentity contains all three section headers
    expect(patch.personaIdentity).toContain('[Self-concept]');
    expect(patch.personaIdentity).toContain('[Voice]');
    expect(patch.personaIdentity).toContain('[Lore]');

    // personaBoundaries contains the bible's boundaries text
    expect(patch.personaBoundaries).toContain('我不假装是真人');

    const fragment = renderPromptPatchFragment(patch);

    const idxIdentity = fragment.indexOf('<persona_identity>');
    const idxBoundaries = fragment.indexOf('<persona_boundaries>');
    const idxMindState = fragment.indexOf('<mind_state>');

    expect(idxIdentity).toBeGreaterThanOrEqual(0);
    expect(idxBoundaries).toBeGreaterThanOrEqual(0);
    expect(idxMindState).toBeGreaterThanOrEqual(0);

    expect(idxIdentity).toBeLessThan(idxBoundaries);
    expect(idxBoundaries).toBeLessThan(idxMindState);
  });
});

// ─── Test 4: Truncation ───────────────────────────────────────────────────────

describe('bible injection — truncation', () => {
  test('bibleMaxCharsPerSection=50, long selfConcept → section text truncated to ≤52 chars', async () => {
    const longSelfConcept = 'A'.repeat(200);
    const patch = await buildPromptPatchAsync(snapshot(), {
      bible: makeBible({ selfConcept: longSelfConcept }),
      injectBible: true,
      bibleMaxCharsPerSection: 50,
    });

    expect(patch.personaIdentity).toBeDefined();

    const identity = patch.personaIdentity ?? '';
    const selfConceptStart = identity.indexOf('[Self-concept]\n') + '[Self-concept]\n'.length;
    // Find end of the Self-concept section (next section header or end of string)
    const voiceStart = identity.indexOf('\n\n[Voice]');
    const loreStart = identity.indexOf('\n\n[Lore]');
    const sectionEnd = voiceStart !== -1 ? voiceStart : loreStart !== -1 ? loreStart : identity.length;

    const selfConceptBody = identity.slice(selfConceptStart, sectionEnd);
    // 50 chars + ' …' = 52 chars max
    expect(selfConceptBody.length).toBeLessThanOrEqual(52);
    expect(selfConceptBody).toContain(' …');
  });
});

// ─── Test 5: Partial bible ────────────────────────────────────────────────────

describe('bible injection — partial bible (no voice)', () => {
  test('selfConcept + lore non-empty, voice empty → [Voice] header not emitted', async () => {
    const patch = await buildPromptPatchAsync(snapshot(), {
      bible: makeBible({ voice: '' }),
      injectBible: true,
      bibleMaxCharsPerSection: 800,
    });

    expect(patch.personaIdentity).toBeDefined();
    expect(patch.personaIdentity).toContain('[Self-concept]');
    expect(patch.personaIdentity).toContain('[Lore]');
    expect(patch.personaIdentity).not.toContain('[Voice]');
  });
});

// ─── Test 6: Render order persona_identity precedes mind_state ────────────────

describe('bible injection — render order', () => {
  test('<persona_identity> precedes <mind_state> in rendered fragment when both present', async () => {
    const patch = await buildPromptPatchAsync(snapshot({ fatigue: 0.9 }), {
      bible: makeBible(),
      injectBible: true,
      bibleMaxCharsPerSection: 800,
    });

    const fragment = renderPromptPatchFragment(patch);
    const idxIdentity = fragment.indexOf('<persona_identity>');
    const idxMindState = fragment.indexOf('<mind_state>');

    expect(idxIdentity).toBeGreaterThanOrEqual(0);
    expect(idxMindState).toBeGreaterThanOrEqual(0);
    expect(idxIdentity).toBeLessThan(idxMindState);
  });
});

// ─── Unit tests for exported helpers ─────────────────────────────────────────

describe('buildPersonaIdentityFragment', () => {
  test('combines sections with labeled headers separated by blank lines', () => {
    const fragment = buildPersonaIdentityFragment(makeBible(), 800);
    expect(fragment).toContain('[Self-concept]\n我是默认人格');
    expect(fragment).toContain('[Voice]\n我说话语气中等');
    expect(fragment).toContain('[Lore]\n我出生于');
  });

  test('empty bible (all sections empty) → returns empty string', () => {
    expect(buildPersonaIdentityFragment(EMPTY_BIBLE, 800)).toBe('');
  });
});

describe('buildPersonaBoundariesFragment', () => {
  test('returns boundaries text when non-empty', () => {
    const result = buildPersonaBoundariesFragment(makeBible(), 800);
    expect(result).toBe('我不假装是真人...');
  });

  test('EMPTY_BIBLE → returns empty string', () => {
    expect(buildPersonaBoundariesFragment(EMPTY_BIBLE, 800)).toBe('');
  });
});
