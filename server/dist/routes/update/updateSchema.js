// WARNING! - Any changes here MUST be the same between app/src/api & server/src/routes/update
import { z } from 'zod';
export const UpdateRequestSchema = z.object({
    targetVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
    allowDowngrade: z.boolean().optional(),
    confirmInUse: z.boolean().optional(),
}).strict();
export const OperationRequestSchema = z.object({
    confirmInUse: z.boolean().optional(),
}).strict();
const upstreamIdentity = {
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    treeSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    date: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).refine(value => {
        const date = new Date(`${value}T00:00:00Z`);
        return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && !value.startsWith('0000');
    }),
};
export const LegacyUpstreamSwitchTargetSchema = z.object(upstreamIdentity).strict();
export const UpstreamSwitchTargetSchema = z.object({
    ...upstreamIdentity,
    treeSha256: z.string().regex(/^[0-9a-f]{64}$/),
    version: z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/),
}).strict();
export const SwitchRequestSchema = OperationRequestSchema.extend({
    target: z.union([UpstreamSwitchTargetSchema, LegacyUpstreamSwitchTargetSchema]).optional(),
}).strict();
export const RollbackInfoSchema = z.object({
    available: z.boolean(),
    version: z.string().nullable(),
});
export const UpdateResultSchema = z.object({
    runId: z.string(),
    operation: z.enum(['update', 'rollback', 'switch']),
    outcome: z.enum(['success', 'up-to-date', 'stopped', 'rolled-back', 'failed']),
    from: z.string().nullable(),
    to: z.string().nullable(),
    message: z.string(),
    finishedAt: z.string(),
});
//# sourceMappingURL=updateSchema.js.map