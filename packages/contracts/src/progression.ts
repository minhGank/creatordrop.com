import { z } from 'zod';

// Policy changes require deliberate platform versioning and a forward migration.
export const xpRewardPolicy = { version: 'xp-v1', minimum: 1n, maximum: 500n } as const;
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/u);
const positive = z.string().regex(/^[1-9][0-9]*$/u);
export const xpRewardSchema = z.strictObject({
  amount: positive.refine(
    (value) => /^[1-9][0-9]{0,2}$/u.test(value) && BigInt(value) <= xpRewardPolicy.maximum,
  ),
  policyVersion: z.literal('xp-v1'),
});
export type XpReward = z.infer<typeof xpRewardSchema>;
export const progressionSchema = z.strictObject({
  lifetimeXp: decimal,
  level: positive,
  xpInLevel: decimal,
  xpForNextLevel: positive,
  universalEntriesAvailable: decimal,
  universalEntriesEarned: decimal,
});
export const progressionResponseSchema = z.strictObject({ progression: progressionSchema });
export type Progression = z.infer<typeof progressionSchema>;
export type ProgressionResponse = z.infer<typeof progressionResponseSchema>;
export const openingProgressionSchema = z.strictObject({
  ...progressionSchema.shape,
  xpAwarded: decimal,
  levelsGained: decimal,
  universalEntriesGranted: decimal,
});
export type OpeningProgression = z.infer<typeof openingProgressionSchema>;
