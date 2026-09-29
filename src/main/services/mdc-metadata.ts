import sax from 'sax'
import type { MediaIdentity } from './media-identity'

const chineseLabels = new Set(['中文字幕', '中字', '字幕', 'subtitles', 'subtitles included'])
const restoredLabels = new Set([
  '破解',
  '无码破解',
  '無碼破解',
  'ai破解',
  'ai 破解',
  'ai去码',
  'ai去碼',
  'ai demosaic',
  'hack',
])

/** 只读取 movie 的直接子字段，不把简介、演员或文件名中的关键词当作标签。 */
export function verifyMdcMetadata(text: string, expected: MediaIdentity): void {
  const invalid = () => {
    throw new Error('MDC 元数据内容无效，未提交输出。')
  }
  if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(text))
    invalid()
  const options: sax.SAXOptions & { strictEntities: boolean } = { strictEntities: true }
  const parser = sax.parser(true, options)
  const stack: { name: string; text: string; children: boolean }[] = []
  const fields = new Map<string, string[]>()
  let roots = 0
  parser.onerror = invalid
  parser.ondoctype = invalid
  parser.onsgmldeclaration = invalid
  parser.onopentag = (node) => {
    if (!stack.length && (++roots !== 1 || node.name !== 'movie')) invalid()
    if (stack.length >= 32) invalid()
    if (stack.length) stack.at(-1)!.children = true
    stack.push({ name: node.name, text: '', children: false })
  }
  parser.ontext = parser.oncdata = (value) => {
    if (stack.length) stack.at(-1)!.text += value
    else if (value.trim()) invalid()
  }
  parser.onclosetag = () => {
    const node = stack.pop()!
    if (stack.length === 1 && !node.children) {
      const values = fields.get(node.name) ?? []
      values.push(node.text.trim())
      fields.set(node.name, values)
    }
  }
  try {
    parser.write(text.replace(/^\uFEFF/, '')).close()
  } catch {
    invalid()
  }
  if (roots !== 1 || stack.length || !fields.get('title')?.some(Boolean)) invalid()
  const labels = [...(fields.get('tag') ?? []), ...(fields.get('genre') ?? [])].map((value) =>
    value.toLowerCase(),
  )
  if (
    (expected.chinese && !labels.some((value) => chineseLabels.has(value))) ||
    (expected.restored && !labels.some((value) => restoredLabels.has(value)))
  )
    throw new Error('MDC 元数据缺少任务要求的中文字幕或破解标签，未提交输出；请检查 MDC 标签配置。')
  const numbers = fields.get('num') ?? []
  if (expected.number && numbers.some((value) => value.toUpperCase() !== expected.number))
    throw new Error('MDC 元数据番号与任务不一致，未提交输出。')
}
