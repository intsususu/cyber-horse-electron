import { z } from 'zod'
import type { MediaDetail } from './media-library'

function webAddress(value: string) {
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('链接需要是无凭据、查询参数和片段的 HTTP 或 HTTPS 地址。')
  return url
}

export const javbusUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    if (!value) return true
    try {
      webAddress(value)
      return true
    } catch {
      return false
    }
  }, 'JavBus 地址需要是无凭据、查询参数和片段的 HTTP 或 HTTPS 地址')
  .default('')

const numberPattern = '(?:[A-Z0-9]{2,12}-){1,2}\\d{2,8}'
const exactNumber = new RegExp(`^${numberPattern}$`, 'i')

export function mediaCatalogNumber(detail: Pick<MediaDetail, 'name' | 'path' | 'sources'>) {
  const identify = (value: string) =>
    [...value.matchAll(new RegExp(`(?:^|[^A-Z0-9])(${numberPattern})(?=$|[^A-Z0-9])`, 'gi'))].map(
      (match) => match[1]!.toUpperCase(),
    )
  const titleNumbers = new Set(identify(detail.name))
  if (titleNumbers.size) return titleNumbers.size === 1 ? [...titleNumbers][0]! : ''
  const fileNumbers = new Set(
    [detail.path, ...detail.sources.map((source) => source.path)].flatMap((path) =>
      identify(path.split(/[\\/]/).at(-1) ?? ''),
    ),
  )
  return fileNumbers.size === 1 ? [...fileNumbers][0]! : ''
}

export function javbusDetailUrl(address: string, number: string) {
  if (!address.trim()) throw new Error('请先配置 JavBus 地址。')
  if (!exactNumber.test(number)) throw new Error('无法识别此视频的唯一番号。')
  const url = webAddress(address)
  const parts = url.pathname.replace(/\/+$/, '').split('/')
  if (exactNumber.test(parts.at(-1) ?? '')) parts.pop()
  url.pathname = `${parts.join('/')}/${encodeURIComponent(number.toUpperCase())}`
  return url.href
}

export function embyDetailUrl(address: string, itemId: string, serverId: string) {
  const url = webAddress(address)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/web/index.html`
  const query = new URLSearchParams({ id: itemId })
  if (serverId) query.set('serverId', serverId)
  url.hash = `!/item?${query}`
  return url.href
}
