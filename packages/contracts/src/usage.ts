import { z } from 'zod';

export const usagePeriodSchema = z.enum([
  'lifetime',
  'current_month',
  'previous_month',
  'last_30_days',
  'custom',
]);
export type UsagePeriod = z.infer<typeof usagePeriodSchema>;
const timestamp = z.iso.datetime({ offset: true }).refine(
  (value) => {
    const year = new Date(value).getUTCFullYear();
    return year >= 1 && year <= 9999 && !/\.\d{4}/u.test(value);
  },
  {
    message:
      'Timestamp must resolve to a supported UTC calendar year with at most millisecond precision.',
  },
);
export const creatorUsageQuerySchema = z
  .strictObject({
    period: usagePeriodSchema.default('current_month'),
    start: timestamp.optional(),
    end: timestamp.optional(),
    after: z
      .uuid()
      .transform((value) => value.toLowerCase())
      .optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9][0-9]?|100)$/u)
      .default('25'),
  })
  .refine(
    (query) =>
      query.period === 'custom'
        ? query.start !== undefined &&
          query.end !== undefined &&
          Date.parse(query.start) < Date.parse(query.end)
        : query.start === undefined && query.end === undefined,
    { message: 'Custom ranges require start before end; presets do not accept boundaries.' },
  );
export type CreatorUsageQuery = z.infer<typeof creatorUsageQuerySchema>;
const decimalPattern = /^(0|[1-9][0-9]*)$/u;
const decimal = z.string().regex(decimalPattern);
const countFields = {
  hostedOpenings: decimal,
  creatorEntitlementOpenings: decimal,
  universalEntryOpenings: decimal,
};
const reconciles = (counts: {
  hostedOpenings: string;
  creatorEntitlementOpenings: string;
  universalEntryOpenings: string;
}): boolean =>
  [counts.hostedOpenings, counts.creatorEntitlementOpenings, counts.universalEntryOpenings].every(
    (value) => decimalPattern.test(value),
  ) &&
  BigInt(counts.hostedOpenings) ===
    BigInt(counts.creatorEntitlementOpenings) + BigInt(counts.universalEntryOpenings);
export const usageCountsSchema = z.strictObject(countFields).refine(reconciles);
export const creatorUsageDataSchema = z.strictObject({
  totals: z.strictObject({
    lifetime: usageCountsSchema,
    currentMonth: usageCountsSchema,
    previousMonth: usageCountsSchema,
    last30Days: usageCountsSchema,
    selected: usageCountsSchema,
  }),
  drops: z
    .array(
      z
        .strictObject({ boxId: z.uuid(), name: z.string().min(1).max(120), ...countFields })
        .refine(reconciles),
    )
    .max(100),
  nextCursor: z.uuid().nullable(),
});
export const creatorUsageResponseSchema = z.strictObject({
  usage: creatorUsageDataSchema.extend({
    asOf: timestamp,
    range: z.strictObject({
      period: usagePeriodSchema,
      start: timestamp.nullable(),
      end: timestamp,
    }),
  }),
});
export type CreatorUsageResponse = z.infer<typeof creatorUsageResponseSchema>;
