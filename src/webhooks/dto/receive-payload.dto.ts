import { z } from 'zod';

export const ReceivePayloadSchema = z.object({
  id: z.string().min(1).max(255),
  type: z.string().min(1).max(128),
  data: z.unknown(),
});

export type ReceivePayload = z.infer<typeof ReceivePayloadSchema>;
