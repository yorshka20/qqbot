/**
 * Persona backend: read-only REST API (/api/persona) for persona state inspection.
 *
 * API contract:
 * - GET  /api/persona/state  -> PersonaStateResponse
 */

import { getContainer } from '@/core/DIContainer';
import { DITokens } from '@/core/DITokens';
import type { EpigeneticsStore } from '@/persona/reflection/epigenetics/EpigeneticsStore';
import type { PersonaService } from '@/persona/PersonaService';
import { logger } from '@/utils/logger';
import type { Backend } from './types';
import { errorResponse, jsonResponse } from './types';

const API_PREFIX = '/api/persona';

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

export interface PersonaStateResponse {
  enabled: boolean;
  personaId: string;
  phenotype: {
    fatigue: number;
    attention: number;
    stimulusCount: number;
    lastStimulusAt?: number;
  };
  modulation: {
    intensityScale: number;
    speedScale: number;
    durationBias: number;
  };
  capturedAt: number;
  epigenetics: {
    currentTone: string;
    behavioralBiases: Record<string, number | string>;
    topicMastery: Record<string, number>;
    learnedPreferences: Record<string, unknown>;
    updatedAt: number;
  } | null;
  recentReflections: Array<{
    id: number;
    timestamp: number;
    trigger: string;
    tone: string | null;
    insightMd: string;
  }>;
  relationships: Array<{
    userId: string;
    affinity: number;
    familiarity: number;
    tags: string[];
    lastInteractionAt: number;
  }>;
}

// ---------------------------------------------------------------------------
// PersonaBackend
// ---------------------------------------------------------------------------

export class PersonaBackend implements Backend {
  readonly prefix = API_PREFIX;
  private personaService: PersonaService | null = null;
  private epigeneticsStore: EpigeneticsStore | null = null;

  private getPersonaService(): PersonaService {
    if (this.personaService) return this.personaService;
    this.personaService = getContainer().resolve<PersonaService>(DITokens.PERSONA_SERVICE);
    return this.personaService;
  }

  /** Returns null if EPIGENETICS_STORE is not registered (MongoDB deployments). */
  private getEpigeneticsStore(): EpigeneticsStore | null {
    if (this.epigeneticsStore) return this.epigeneticsStore;
    const c = getContainer();
    if (!c.isRegistered(DITokens.EPIGENETICS_STORE)) return null;
    this.epigeneticsStore = c.resolve<EpigeneticsStore>(DITokens.EPIGENETICS_STORE);
    return this.epigeneticsStore;
  }

  async handle(pathname: string, req: Request): Promise<Response | null> {
    if (!pathname.startsWith(API_PREFIX)) return null;
    const subPath = pathname.slice(API_PREFIX.length);
    if (req.method === 'GET' && subPath === '/state') {
      return this.handleState();
    }
    return errorResponse('Not found', 404);
  }

  private async handleState(): Promise<Response> {
    try {
      const snapshot = this.getPersonaService().getSnapshot();
      const { personaId } = snapshot;

      const store = this.getEpigeneticsStore();
      if (!store) {
        return jsonResponse<PersonaStateResponse>({
          ...snapshot,
          epigenetics: null,
          recentReflections: [],
          relationships: [],
        });
      }

      const [epiRaw, reflectionsRaw, relationshipsRaw] = await Promise.all([
        store.getEpigenetics(personaId),
        store.getRecentReflections(personaId, 10),
        store.listRelationships(personaId, { limit: 100 }),
      ]);

      let epigenetics: PersonaStateResponse['epigenetics'] = null;
      if (epiRaw) {
        const tone =
          typeof epiRaw.behavioralBiases.currentTone === 'string'
            ? epiRaw.behavioralBiases.currentTone
            : 'neutral';
        epigenetics = {
          currentTone: tone,
          behavioralBiases: epiRaw.behavioralBiases,
          topicMastery: epiRaw.topicMastery,
          learnedPreferences: epiRaw.learnedPreferences,
          updatedAt: epiRaw.updatedAt,
        };
      }

      const recentReflections = reflectionsRaw.map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        trigger: r.trigger,
        tone: r.appliedPatch.currentTone ?? null,
        insightMd: r.insightMd,
      }));

      // listRelationships does not support orderBy lastInteractionAt — sort in JS
      const relationships = relationshipsRaw
        .slice()
        .sort((a, b) => (b.lastInteractionAt ?? 0) - (a.lastInteractionAt ?? 0))
        .slice(0, 50)
        .map((r) => ({
          userId: r.userId,
          affinity: r.affinity,
          familiarity: r.familiarity,
          tags: r.tags,
          lastInteractionAt: r.lastInteractionAt,
        }));

      return jsonResponse<PersonaStateResponse>({
        ...snapshot,
        epigenetics,
        recentReflections,
        relationships,
      });
    } catch (err) {
      logger.error('[PersonaBackend] state error:', err);
      return errorResponse('Failed to read persona state', 500);
    }
  }
}
