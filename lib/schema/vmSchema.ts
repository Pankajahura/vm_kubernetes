import { z } from 'zod';

export const vmCreateSchema = z.object({
  ipAddress: z.string(),
  username: z.string().min(1),
  password: z.string().min(1),
  location: z.string().min(1),
  ram: z.int().min(1),
  storage: z.int().min(1),
  cpu: z.int().min(1),
  status: z.enum(['free', 'used']).optional().default('free'),
});

export const vmFetchSchema = z.object({
  location: z.string().min(1),
  number: z.coerce.number().int().positive().default(1),
   ram: z.coerce.number().int().positive(),
  storage: z.coerce.number().int().positive(),
  cpu: z.coerce.number().int().positive(),
});
