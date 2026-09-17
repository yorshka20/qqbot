// Reports the NovelAI account's Opus image allowance.
//
// V5 is the first model family whose free generations draw on a limited, refilling
// allowance rather than the unlimited Opus perk the earlier families get, so "is this
// generation free?" is account state, not a property of the request. Only the account
// endpoint can answer it. Fields and arithmetic mirror NovelAI's own client:
// `subscription.usage` carries the percentage, and a full bar is worth ~1730 images.
//
// Usage: bun run packages/bot/src/cli/nai-usage.ts

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfigAuto } from '@/core/config/loadConfigDir';
import type { NovelAIProviderConfig } from '@/core/config/types/ai/providers';
import { getRepoRoot } from '@/utils/repoRoot';

/** NovelAI's own estimate: one percent of the bar is worth this many images. */
const IMAGES_PER_PERCENT = 17.3;

/** Opus is subscription tier 3; lower tiers get no allowance at all. */
const OPUS_TIER = 3;

type NovelAIUsage = {
  percent: number;
  isNegative: boolean;
  timeUntilNextPercent: number;
};

/** Older accounts report a bare number here; current ones split grant from purchase. */
type NovelAITrainingSteps = number | { fixedTrainingStepsLeft?: number; purchasedTrainingSteps?: number };

type NovelAIAccountInformation = {
  /** NovelAI hashes the address unless the account opted into storing it in the clear. */
  plaintextEmail?: string | null;
  hasPlaintextEmail?: boolean;
  emailVerified?: boolean;
  accountCreatedAt?: number;
  banStatus?: string;
};

type NovelAIUserData = {
  information?: NovelAIAccountInformation;
  subscription?: {
    tier?: number;
    active?: boolean;
    expiresAt?: number;
    usage?: NovelAIUsage;
    /** Anlas. The subscription grant and purchased balance are tracked separately. */
    trainingStepsLeft?: NovelAITrainingSteps;
    paymentProcessorData?: unknown;
  };
};

/** Anlas balance, summing the subscription grant and any purchased top-up. */
function anlasBalance(left: NovelAITrainingSteps | undefined): number {
  if (typeof left === 'number') {
    return left;
  }
  if (left) {
    return (left.fixedTrainingStepsLeft ?? 0) + (left.purchasedTrainingSteps ?? 0);
  }
  return 0;
}

function estimateImages(percent: number): number {
  return Math.round(IMAGES_PER_PERCENT * percent);
}

/** Percent restored per day, derived from the seconds left until the next percent lands. */
function refillPercentPerDay(usage: NovelAIUsage): number {
  if (usage.timeUntilNextPercent <= 0) {
    return 0;
  }
  return Math.round((86400 / usage.timeUntilNextPercent) * 10) / 10;
}

function resolveConfigPath(): string {
  const candidates = [
    process.env.CONFIG_PATH,
    resolve(getRepoRoot(), 'config.d'),
    resolve(getRepoRoot(), 'config.jsonc'),
  ];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) {
    throw new Error('Config not found (looked at CONFIG_PATH, config.d/, config.jsonc)');
  }
  return found;
}

async function main(): Promise<void> {
  const config = loadConfigAuto(resolveConfigPath()) as {
    ai?: { providers?: Record<string, { type?: string } | undefined> };
  };
  const providers = config.ai?.providers ?? {};
  const novelai = Object.values(providers).find((p) => p?.type === 'novelai') as NovelAIProviderConfig | undefined;

  if (!novelai?.accessToken) {
    console.error('No NovelAI provider with an accessToken is configured.');
    process.exit(1);
  }

  const baseURL = novelai.baseURL ?? 'https://image.novelai.net';
  const response = await fetch(`${baseURL.replace(/\/$/, '')}/user/data`, {
    headers: { Authorization: `Bearer ${novelai.accessToken}` },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    console.error(`NovelAI rejected the request: HTTP ${response.status}`);
    process.exit(1);
  }

  const data = (await response.json()) as NovelAIUserData;
  const subscription = data.subscription;
  const tier = subscription?.tier ?? 0;

  const info = data.information;
  const email = info?.plaintextEmail;
  console.log('── account ──');
  console.log(
    `email            : ${email ?? (info?.hasPlaintextEmail === false ? '(stored hashed — NovelAI cannot show it)' : '(not reported)')}`,
  );
  if (info?.accountCreatedAt) {
    console.log(`created          : ${new Date(info.accountCreatedAt * 1000).toISOString().slice(0, 10)}`);
  }
  if (info?.banStatus) {
    console.log(`ban status       : ${info.banStatus}`);
  }
  const expiresAt = data.subscription?.expiresAt;
  if (expiresAt) {
    console.log(`subscription ends: ${new Date(expiresAt * 1000).toISOString().slice(0, 10)}`);
  }
  console.log(`payment on file  : ${data.subscription?.paymentProcessorData ? 'yes' : 'no'}`);

  console.log('\n── generation ──');
  console.log(`model configured : ${novelai.model ?? '(provider default)'}`);
  console.log(`subscription tier: ${tier}${tier >= OPUS_TIER ? ' (Opus)' : ' (below Opus)'}`);
  console.log(`active           : ${subscription?.active ?? false}`);
  console.log(`Anlas balance    : ${anlasBalance(subscription?.trainingStepsLeft)}`);

  const usage = subscription?.usage;
  if (!usage) {
    console.log('\nNo V5 allowance reported for this account.');
    return;
  }

  const percent = usage.isNegative ? 0 : Math.max(0, usage.percent);
  const perDay = refillPercentPerDay(usage);

  console.log(`\nV5 Opus allowance: ${Math.min(100, percent)}%  (~${estimateImages(percent)} images)`);
  console.log(`refill           : ${perDay}%/day (~${estimateImages(perDay)} images/day)`);

  if (usage.isNegative || percent === 0) {
    console.log('\nEXHAUSTED — every V5 generation is billed in Anlas until this refills.');
  } else if (percent < 5) {
    console.log('\nLOW — the allowance is nearly gone.');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
