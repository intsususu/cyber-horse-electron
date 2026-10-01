import { z } from 'zod'

// 字号、描边和边距均以 1920 × 1080 的 ASS 脚本坐标为基准。
export const subtitleStyleSchema = z
  .object({
    fontName: z
      .string()
      .trim()
      .min(1, '请填写字幕字体名称')
      .max(100)
      .regex(/^[^,\r\n\x00-\x1f\x7f{}\\"']+$/, '字体名称不能包含逗号、引号或控制字符')
      .default('Microsoft YaHei'),
    fontSize: z.number().int().min(16).max(120).default(56),
    bold: z.boolean().default(true),
    italic: z.boolean().default(false),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default('#FFFFFF'),
    outlineColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default('#000000'),
    outlineWidth: z.number().min(0).max(8).default(3),
    shadow: z.number().min(0).max(8).default(1.5),
    marginBottom: z.number().int().min(0).max(200).default(60),
  })
  .strict()

export type SubtitleStyle = z.infer<typeof subtitleStyleSchema>
export const defaultSubtitleStyle = subtitleStyleSchema.parse({})
