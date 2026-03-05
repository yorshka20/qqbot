/**
 * Zod schema for prefix-invitation check JSON output.
 * Used by PrefixInvitationCheckService when message trigger is provider-name prefix.
 */

import { z } from 'zod';

export const PrefixInvitationSchema = z.object({
  shouldReply: z.unknown().transform((v): boolean => v === true),
  reason: z
    .unknown()
    .optional()
    .transform((v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)),
});

export type PrefixInvitationResult = z.infer<typeof PrefixInvitationSchema>;
