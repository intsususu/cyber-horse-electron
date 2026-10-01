import { z } from 'zod'
import { mediaIdSchema, type LibraryVideo } from './media-library'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const popularGroupSchema = z
  .object({
    id: mediaIdSchema,
    name: z.string().min(1).max(1024),
    videos: count,
    plays: count,
    favorites: count,
    score: z.number().finite().min(0).max(100.001),
    videoIds: z.array(mediaIdSchema).max(200000),
  })
  .strict()
export type PopularGroup = z.infer<typeof popularGroupSchema>
export const popularIndexSchema = z
  .object({
    version: z.literal(1),
    identity: z.string().regex(/^[a-f0-9]{64}$/),
    updatedAt: z.string().datetime(),
    totals: z
      .object({
        videos: count,
        plays: count,
        favorites: count,
        missingPeople: count,
        series: count,
        actors: count,
      })
      .strict(),
    groups: z
      .object({
        series: z.array(popularGroupSchema).max(15),
        actors: z.array(popularGroupSchema).max(15),
      })
      .strict(),
  })
  .strict()
export type PopularIndex = z.infer<typeof popularIndexSchema>
export type PopularState = {
  index: PopularIndex | null
  scanning: boolean
  progress: string
  error: string
  nextUpdate: string | null
}
export const popularPageSchema = z
  .object({
    kind: z.enum(['series', 'actors']),
    id: mediaIdSchema,
    updatedAt: z.string().datetime(),
    start: z.number().int().min(0).max(200000),
    sort: z.enum(['DateCreated', 'DatePlayed', 'PlayCount']).optional(),
    favorites: z.boolean().optional(),
    searchTerm: z.string().trim().max(200).optional(),
    reload: z.boolean().optional(),
  })
  .strict()
export type PopularPageQuery = z.infer<typeof popularPageSchema>
export type PopularLibraryVideo = LibraryVideo & {
  playCount: number | null
  created: string
  lastPlayed: string
}
export type PopularVideoPage = {
  items: LibraryVideo[]
  next: number
  total: number
  missing: number
}
export interface MediaPopularApi {
  getMediaPopular(): Promise<PopularState>
  refreshMediaPopular(): Promise<PopularState>
  cancelMediaPopular(): Promise<void>
  getMediaPopularPage(query: PopularPageQuery): Promise<PopularVideoPage>
}

// 扫描中间数据仅驻留内存，不保存视频详情或图片。
export type PopularScanVideo = {
  id: string
  plays: number
  favorite: boolean
  people: { id: string; name: string }[]
}
export type PopularScan = {
  videos: PopularScanVideo[]
  series: { id: string; name: string; videoIds: string[] }[]
}
