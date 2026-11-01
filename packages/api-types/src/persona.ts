// `/api/persona` — read-only persona state.

export interface PersonaPhenotype {
  fatigue: number;
  attention: number;
  stimulusCount: number;
  lastStimulusAt?: number;
}

export interface PersonaModulation {
  intensityScale: number;
  speedScale: number;
  durationBias: number;
}

export interface PersonaEpigeneticsView {
  currentTone: string;
  behavioralBiases: Record<string, number | string>;
  topicMastery: Record<string, number>;
  learnedPreferences: Record<string, unknown>;
  updatedAt: number;
}

export interface PersonaReflectionView {
  id: number;
  timestamp: number;
  trigger: string;
  tone: string | null;
  insightMd: string;
}

export interface PersonaRelationshipView {
  userId: string;
  affinity: number;
  familiarity: number;
  tags: string[];
  lastInteractionAt: number;
}

/** `GET /api/persona/state`; `epigenetics` is null on deployments without the store. */
export interface PersonaStateResponse {
  enabled: boolean;
  personaId: string;
  phenotype: PersonaPhenotype;
  modulation: PersonaModulation;
  capturedAt: number;
  epigenetics: PersonaEpigeneticsView | null;
  recentReflections: PersonaReflectionView[];
  relationships: PersonaRelationshipView[];
}
