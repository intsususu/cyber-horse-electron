import { z } from 'zod'
import { mediaIdSchema } from './media-library'

// 缺失的播放次数不能当作零；只保存迁移所需的用户数据，不复制旧条目的 Key。
export const mediaUserDataSchema = z.object({
  IsFavorite: z.boolean(),
  PlayCount: z.number().int().nonnegative().max(2147483647),
  Played: z.boolean(),
  PlaybackPositionTicks: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  LastPlayedDate: z
    .string()
    .datetime({ offset: true })
    .nullish()
    .transform((v) => v ?? null),
  Rating: z.number().finite().nullable().optional(),
})

export const mediaUserDataSnapshotSchema = z
  .object({
    identity: z.string().regex(/^[a-f0-9]{64}$/),
    itemId: mediaIdSchema,
    capturedAt: z.string().datetime(),
    data: mediaUserDataSchema,
  })
  .strict()

export type MediaUserData = z.infer<typeof mediaUserDataSchema>
export type MediaUserDataSnapshot = z.infer<typeof mediaUserDataSnapshotSchema>

/** 重试不累加播放次数；保留新条目已有的收藏、较大次数与较新播放位置。 */
export function mergeMediaUserData(saved: MediaUserData, current: MediaUserData): MediaUserData {
  const savedTime = saved.LastPlayedDate ? Date.parse(saved.LastPlayedDate) : 0
  const currentTime = current.LastPlayedDate ? Date.parse(current.LastPlayedDate) : 0
  const playback =
    savedTime > currentTime ||
    (savedTime === currentTime &&
      current.PlayCount === 0 &&
      current.PlaybackPositionTicks === 0 &&
      !current.Played)
      ? saved
      : current
  return {
    ...current,
    IsFavorite: saved.IsFavorite || current.IsFavorite,
    PlayCount: Math.max(saved.PlayCount, current.PlayCount),
    Played: saved.Played || current.Played,
    PlaybackPositionTicks: playback.PlaybackPositionTicks,
    LastPlayedDate: playback.LastPlayedDate,
    ...(current.Rating == null && saved.Rating != null ? { Rating: saved.Rating } : {}),
  }
}

export function containsMediaUserData(actual: MediaUserData, expected: MediaUserData): boolean {
  const newer =
    actual.LastPlayedDate !== null &&
    Date.parse(actual.LastPlayedDate) >
      (expected.LastPlayedDate ? Date.parse(expected.LastPlayedDate) : 0)
  return (
    (!expected.IsFavorite || actual.IsFavorite) &&
    actual.PlayCount >= expected.PlayCount &&
    (!expected.Played || actual.Played) &&
    (newer ||
      (actual.PlaybackPositionTicks === expected.PlaybackPositionTicks &&
        (actual.LastPlayedDate === expected.LastPlayedDate ||
          (actual.LastPlayedDate !== null &&
            expected.LastPlayedDate !== null &&
            Date.parse(actual.LastPlayedDate) === Date.parse(expected.LastPlayedDate))))) &&
    (expected.Rating == null || actual.Rating === expected.Rating)
  )
}
