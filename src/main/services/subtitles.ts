import {
  defaultSubtitleStyle,
  subtitleStyleSchema,
  type SubtitleStyle,
} from '../../shared/subtitle-style'

export type SubtitleCue = { start: number; end: number; text: string[] }
export function parseSrt(bytes: Uint8Array): SubtitleCue[] {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true })
      .decode(bytes)
      .replace(/^\uFEFF/, '')
      .trim()
  } catch {
    throw new Error('字幕不是有效的 UTF-8 文本。')
  }
  if (!text || text.length > 8 * 1024 * 1024) throw new Error('字幕为空或超过 8 MiB。')
  const time = (value: string) => {
    const match = /^(\d{1,5}):([0-5]\d):([0-5]\d),(\d{3})$/.exec(value)
    if (!match) throw new Error('字幕时间轴格式无效。')
    return (
      Number(match[1]) * 3600000 +
      Number(match[2]) * 60000 +
      Number(match[3]) * 1000 +
      Number(match[4])
    )
  }
  return text.split(/\r?\n[ \t]*\r?\n/).map((block, index) => {
    const lines = block.split(/\r?\n/)
    const range = lines[1]?.trim().split(/\s*-->\s*/)
    if (
      !/^\d+$/.test(lines[0]?.trim() ?? '') ||
      range?.length !== 2 ||
      !lines.slice(2).some((line) => line.trim())
    )
      throw new Error(`字幕第 ${index + 1} 条格式或内容无效。`)
    const start = time(range[0]!),
      end = time(range[1]!)
    if (end <= start) throw new Error(`字幕第 ${index + 1} 条结束时间无效。`)
    return { start, end, text: lines.slice(2) }
  })
}
export function srtToAss(cues: SubtitleCue[], style: SubtitleStyle = defaultSubtitleStyle): string {
  const s = subtitleStyleSchema.strip().parse(style)
  const color = (hex: string) =>
    `&H00${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase()
  const styleLine = `Style: Default,${s.fontName},${s.fontSize},${color(s.color)},&H000000FF,${color(s.outlineColor)},&H80000000,${s.bold ? -1 : 0},${s.italic ? -1 : 0},0,0,100,100,0,0,1,${s.outlineWidth},${s.shadow},2,40,40,${s.marginBottom},1`
  const time = (value: number) =>
    `${Math.floor(value / 360000)}:${String(Math.floor(value / 6000) % 60).padStart(2, '0')}:${String(Math.floor(value / 100) % 60).padStart(2, '0')}.${String(value % 100).padStart(2, '0')}`
  const header =
    '[Script Info]\nTitle: 中文字幕\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,Microsoft YaHei,56,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1.5,2,40,40,60,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n'
  return (
    header.replace(/^Style: Default,.*$/m, () => styleLine) +
    cues
      .map((cue) => {
        const start = Math.round(cue.start / 10),
          end = Math.max(start + 1, Math.round(cue.end / 10))
        const text = cue.text
          .map((line) => line.replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝'))
          .join('\\N')
        return `Dialogue: 0,${time(start)},${time(end)},Default,,0,0,0,,${text}\n`
      })
      .join('')
  )
}
