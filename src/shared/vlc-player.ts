import { z } from 'zod'
import { mediaPlaybackSchema } from './media-library'

export const vlcBoundsSchema = z
  .object({
    x: z.number().finite().min(0).max(32768),
    y: z.number().finite().min(0).max(32768),
    width: z.number().finite().min(0).max(32768),
    height: z.number().finite().min(0).max(32768),
    visible: z.boolean(),
  })
  .strict()
export const vlcOpenSchema = mediaPlaybackSchema
  .omit({ transcode: true })
  .extend({
    requestId: z.string().uuid(),
    bounds: vlcBoundsSchema,
  })
  .strict()
export const vlcControlSchema = z.discriminatedUnion('action', [
  z
    .object({ token: z.string().uuid(), action: z.literal('bounds'), bounds: vlcBoundsSchema })
    .strict(),
  z.object({ token: z.string().uuid(), action: z.literal('pause'), paused: z.boolean() }).strict(),
  z
    .object({
      token: z.string().uuid(),
      action: z.literal('seek'),
      seconds: z.number().finite().min(0).max(86400),
    })
    .strict(),
  z
    .object({
      token: z.string().uuid(),
      action: z.literal('audio'),
      volume: z.number().finite().min(0).max(1),
      muted: z.boolean(),
    })
    .strict(),
  z
    .object({
      token: z.string().uuid(),
      action: z.literal('subtitle'),
      index: z.number().int().min(0).max(200000).nullable(),
    })
    .strict(),
])
export const vlcStateSchema = z
  .object({
    token: z.string().uuid(),
    status: z.enum(['loading', 'playing', 'paused', 'ended', 'failed']),
    position: z.number().finite().min(0),
    duration: z.number().finite().positive().nullable(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    surfaceVisible: z.boolean().optional(),
    embedded: z.boolean().optional(),
    surfaceOnTop: z.boolean().optional(),
    surfaceBounds: z
      .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
      .optional(),
    volume: z.number().min(0).max(1),
    muted: z.boolean(),
    subtitles: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(200000),
            name: z.string().max(512),
            language: z.string(),
            codec: z.string(),
            isText: z.boolean(),
          })
          .strict(),
      )
      .max(256),
    subtitleIndex: z.number().int().nullable(),
    message: z.string().max(1024),
  })
  .strict()
export type VlcBounds = z.infer<typeof vlcBoundsSchema>
export type VlcOpenRequest = z.infer<typeof vlcOpenSchema>
export type VlcControl = z.infer<typeof vlcControlSchema>
export type VlcState = z.infer<typeof vlcStateSchema>
export type VlcAvailability = { available: boolean; message: string }
export interface VlcPlayerApi {
  getVlcAvailability(): Promise<VlcAvailability>
  openVlcPlayback(request: VlcOpenRequest): Promise<VlcState | null>
  controlVlcPlayback(request: VlcControl): Promise<void>
  getVlcPlayback(token: string): Promise<VlcState | null>
  closeVlcPlayback(token: string): Promise<void>
}
