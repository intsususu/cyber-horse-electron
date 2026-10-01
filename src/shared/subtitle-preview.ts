import { z } from 'zod'
import { subtitleStyleSchema } from './subtitle-style'

export const subtitlePreviewRequestSchema = z
  .object({ id: z.uuid(), style: subtitleStyleSchema })
  .strict()
export const subtitlePreviewCancelSchema = z.object({ id: z.uuid() }).strict()
export type SubtitlePreviewRequest = z.infer<typeof subtitlePreviewRequestSchema>
export type SubtitlePreviewResult = { bytes: Uint8Array; duration: number }
export const subtitlePreviewCues = [
  { start: 0, end: 3500, text: ['午后的风，轻轻吹过窗边。'] },
  { start: 3500, end: 7000, text: ['把脚步放慢，看看沿途的风景。'] },
  { start: 7000, end: 11000, text: ['有些平凡的瞬间，也值得被记住。'] },
  { start: 11000, end: 15000, text: ['每一段故事，都值得被听见。'] },
]
