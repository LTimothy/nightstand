// WARNING! - Any changes here MUST be the same between app/src/api & server/src/db/
import { z } from 'zod';
export const StorageInfoSchema = z.object({
    mountPath: z.string(),
    totalBytes: z.number(),
    usedBytes: z.number(),
    availableBytes: z.number(),
    usedPercent: z.number(),
    breakdown: z.object({
        logsBytes: z.number(),
        biometricsArchiveBytes: z.number(),
        databaseBytes: z.number(),
    }),
    // Missing off-Pod and on releases before 3.7.0.
    flash: z.object({
        lifeTimeA: z.number().nullable(),
        lifeTimeB: z.number().nullable(),
        preEolInfo: z.number().nullable(),
        writtenBytesPerDay: z.number().nullable(),
    }).optional(),
});
//# sourceMappingURL=storageSchema.js.map