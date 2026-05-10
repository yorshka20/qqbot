import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '@/utils/logger';

export const CoreDNASchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string(),
    identity: z
      .object({
        bigFive: z
          .object({
            openness: z.number().min(0).max(1),
            conscientiousness: z.number().min(0).max(1),
            extraversion: z.number().min(0).max(1),
            agreeableness: z.number().min(0).max(1),
            neuroticism: z.number().min(0).max(1),
          })
          .strict(),
        values: z.array(z.string()).default([]),
        linguistic: z
          .object({
            catchphrases: z.array(z.string()).default([]),
            forbiddenWords: z.array(z.string()).default([]),
          })
          .strict(),
      })
      .strict(),
    modulation: z
      .object({
        amplitude: z
          .object({
            intensityScale: z.number().min(0).default(1),
            perCategoryScale: z.record(z.string(), z.number().min(0)).optional(),
          })
          .strict(),
        timing: z
          .object({
            speedScale: z.number().min(0.1).max(10).default(1),
            durationBias: z.number().default(0),
            jitterScale: z.number().min(0).default(1),
            idleGapScale: z.number().min(0.1).default(1),
          })
          .strict(),
        spatial: z
          .object({
            postureLeanBaseline: z.number().min(-1).max(1),
            headTiltBias: z.number().min(-1).max(1),
            gazeDistributionBaseline: z
              .object({
                camera: z.number().min(0),
                side: z.number().min(0),
                down: z.number().min(0),
              })
              .strict(),
            fatigueResponse: z
              .object({
                leanGain: z.number(),
                cameraDrop: z.number(),
                sideRise: z.number(),
                downRise: z.number(),
              })
              .strict(),
          })
          .strict(),
        actionPref: z
          .object({
            variantWeights: z.record(z.string(), z.array(z.number())).default({}),
            forbiddenActions: z.array(z.string()).default([]),
          })
          .strict(),
        ambient: z
          .object({
            gainScale: z.number().min(0).default(1),
            fatigueDrop: z.number().min(0).max(1).default(0.3),
          })
          .strict(),
      })
      .strict(),
    emotion: z
      .object({
        valenceBaseline: z.number().min(-1).max(1).default(0),
        arousalBaseline: z.number().min(-1).max(1).default(0),
        dominanceBaseline: z.number().min(-1).max(1).default(0),
        tauValenceMs: z.number().positive().default(600000),
        tauArousalMs: z.number().positive().default(180000),
        tauDominanceMs: z.number().positive().default(1800000),
        valenceFloor: z.number().default(-1),
        valenceCeiling: z.number().default(1),
        fatigueIntensityDrop: z.number().min(0).max(1).default(0.4),
        fatigueSpeedDrop: z.number().min(0).max(1).default(0.3),
      })
      .strict(),
    _meta: z
      .object({
        schemaVersion: z.literal(1),
        notes: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export type CoreDNA = z.infer<typeof CoreDNASchema>;

export const DEFAULT_CORE_DNA: CoreDNA = {
  id: 'default',
  displayName: '默认人格',
  identity: {
    bigFive: { openness: 0.6, conscientiousness: 0.5, extraversion: 0.55, agreeableness: 0.6, neuroticism: 0.4 },
    values: [],
    linguistic: { catchphrases: [], forbiddenWords: [] },
  },
  modulation: {
    amplitude: { intensityScale: 1.0, perCategoryScale: { emotion: 1.0, movement: 1.0, micro: 1.0 } },
    timing: { speedScale: 1.0, durationBias: 0, jitterScale: 1.0, idleGapScale: 1.0 },
    spatial: {
      postureLeanBaseline: 0.08,
      headTiltBias: 0,
      gazeDistributionBaseline: { camera: 0.6, side: 0.3, down: 0.1 },
      fatigueResponse: { leanGain: 0.25, cameraDrop: 0.4, sideRise: 0.2, downRise: 0.2 },
    },
    actionPref: { variantWeights: {}, forbiddenActions: [] },
    ambient: { gainScale: 1.0, fatigueDrop: 0.3 },
  },
  emotion: {
    valenceBaseline: 0,
    arousalBaseline: 0,
    dominanceBaseline: 0,
    tauValenceMs: 600_000,
    tauArousalMs: 180_000,
    tauDominanceMs: 1_800_000,
    valenceFloor: -1,
    valenceCeiling: 1,
    fatigueIntensityDrop: 0.4,
    fatigueSpeedDrop: 0.3,
  },
  _meta: { schemaVersion: 1, notes: 'default persona — 中性基线，所有数值与原 hardcoded 一致' },
};

export interface CoreDNALoaderOptions {
  dataDir: string;
  personaId: string;
}

export async function loadCoreDNA(opts: CoreDNALoaderOptions): Promise<CoreDNA> {
  const file = path.join(opts.dataDir, opts.personaId, 'core-dna.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      logger.warn(`[CoreDNALoader] file missing, using default | persona=${opts.personaId} path=${file}`);
      return DEFAULT_CORE_DNA;
    }
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    logger.error(
      `[CoreDNALoader] JSON parse failed | persona=${opts.personaId} path=${file}: ${(err as Error).message}`,
    );
    throw err;
  }
  const parsed = CoreDNASchema.safeParse(json);
  if (!parsed.success) {
    logger.error(`[CoreDNALoader] schema validation failed | persona=${opts.personaId}: ${parsed.error.message}`);
    throw parsed.error;
  }
  logger.info(`[CoreDNALoader] loaded persona=${opts.personaId} | path=${file}`);
  return parsed.data;
}
