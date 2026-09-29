import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { collectMediaInputs } from '../src/main/services/media-inputs'
import { inputRequestSchema, refreshInputRequestSchema } from '../src/shared/contracts'

const base = resolve('test-results')
const temporary: string[] = []
async function fixture() {
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'media-unit-'))
  temporary.push(root)
  await mkdir(join(root, 'nested'))
  await writeFile(join(root, 'a.MP4'), '原始内容')
  await writeFile(join(root, 'b.mkv'), '另一个视频')
  await writeFile(join(root, 'a.srt'), '字幕不作为独立视频输入')
  await writeFile(join(root, 'nested', 'c.mov'), '子目录视频')
  return root
}
afterEach(async () => {
  for (const root of temporary.splice(0)) {
    if (!resolve(root).startsWith(base + sep)) throw new Error('临时目录超出测试范围')
    await rm(root, { recursive: true, force: true })
  }
})
describe('媒体输入范围', () => {
  it('目录默认只选本层视频，明确递归后包含子目录，且不改写原文件', async () => {
    const root = await fixture()
    const flat = await collectMediaInputs([root], false, true)
    expect(flat.files.map((file) => file.name)).toEqual(['a.MP4', 'b.mkv'])
    const info = await stat(join(root, 'a.MP4'))
    expect(flat.files[0]).toMatchObject({ size: info.size, modifiedAt: info.mtimeMs })
    const recursive = await collectMediaInputs([root], true, true)
    expect(recursive.files).toHaveLength(3)
    expect(recursive.files.find((file) => file.name === 'c.mov')?.relativePath).toBe(
      join('nested', 'c.mov'),
    )
    expect(await readFile(join(root, 'a.MP4'), 'utf8')).toBe('原始内容')
  })
  it('单选、多选去重，并跳过失效文件', async () => {
    const root = await fixture()
    const file = join(root, 'a.MP4')
    expect((await collectMediaInputs([file], false, false)).files).toHaveLength(1)
    const result = await collectMediaInputs(
      [file, file, join(root, 'b.mkv'), join(root, 'missing.mp4')],
      false,
      false,
    )
    expect(result.files).toHaveLength(2)
    expect(result.skipped).toBe(1)
  })
  it('不跟随目录链接，超量范围拒绝返回不完整的“全部文件”', async () => {
    const root = await fixture()
    await symlink(
      join(root, 'nested'),
      join(root, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const result = await collectMediaInputs([root], true, true)
    expect(result.files).toHaveLength(3)
    expect(result.skipped).toBe(1)
    await expect(collectMediaInputs([root], true, true, 2)).rejects.toThrow('超过 2 个')
    await expect(collectMediaInputs([join(root, 'linked')], true, true)).rejects.toThrow('符号链接')
  })
  it('拒绝任意参数、空范围与相对路径', async () => {
    expect(
      refreshInputRequestSchema.safeParse({ source: 'preprocess', recursive: true }).success,
    ).toBe(true)
    expect(
      refreshInputRequestSchema.safeParse({ source: 'download', recursive: true }).success,
    ).toBe(true)
    expect(
      refreshInputRequestSchema.safeParse({ source: 'current', recursive: false }).success,
    ).toBe(true)
    expect(refreshInputRequestSchema.safeParse({ source: 'custom', recursive: true }).success).toBe(
      false,
    )
    expect(
      refreshInputRequestSchema.safeParse({ source: 'preprocess', recursive: true, path: 'C:/' })
        .success,
    ).toBe(false)
    expect(
      inputRequestSchema.safeParse({ mode: 'files', recursive: false, command: '执行' }).success,
    ).toBe(false)
    await expect(collectMediaInputs([], false, false)).rejects.toThrow('绝对路径')
    await expect(collectMediaInputs(['relative.mp4'], false, false)).rejects.toThrow('绝对路径')
  })
})
