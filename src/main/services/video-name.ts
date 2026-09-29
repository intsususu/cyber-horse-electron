/** 沿用参考项目的编号、U/C/UC 标记与 restored 后缀规则。 */
export function canonicalVideoName(input: string): string | null {
  const normalized = input
    .trim()
    .replace(/[._-]?restored$/i, '')
    .replace(/^.*@(?=[a-z]{2,6}-\d{2,6})/i, '')
  const match = /([a-z]{2,6})-?([0-9]{2,6})(?:[-_. ]?(UC|U|C))?/i.exec(normalized)
  return match
    ? `${match[1]!.toUpperCase()}-${match[2]}${match[3] ? `-${match[3].toUpperCase()}` : ''}`
    : null
}
