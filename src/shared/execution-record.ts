import { z } from 'zod'

export const executionRecordSchema = z
  .object({
    kind: z.enum(['media-process', 'pipeline', 'preparation']),
    id: z.string().uuid(),
  })
  .strict()
export type ExecutionRecordRequest = z.infer<typeof executionRecordSchema>
