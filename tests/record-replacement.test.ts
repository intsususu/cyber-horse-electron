import { afterEach, expect, it } from 'vitest'
import { mkdtemp, writeFile, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { replaceRecordFile } from '../src/main/services/record-replacement'

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'horse-record-replace-'))
  roots.push(root)
  const source = join(root, '记录.tmp'),
    target = join(root, '记录.json')
  await writeFile(source, '新记录')
  await writeFile(target, '原记录')
  return { source, target }
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
it('短暂文件占用消失后原子替换，等待期间原记录保持完整', async () => {
  const f = await fixture()
  let attempts = 0
  await replaceRecordFile(f.source, f.target, async (...paths) => {
    expect(await readFile(f.target, 'utf8')).toBe('原记录')
    if (++attempts < 3) throw Object.assign(new Error('短暂占用'), { code: 'EPERM' })
    await rename(...paths)
  })
  expect(attempts).toBe(3)
  expect(await readFile(f.target, 'utf8')).toBe('新记录')
})
it('持续占用有界失败，保留原记录与已写好的临时记录', async () => {
  const f = await fixture()
  let attempts = 0
  await expect(
    replaceRecordFile(f.source, f.target, async () => {
      attempts++
      throw Object.assign(new Error('持续占用'), { code: 'EBUSY' })
    }),
  ).rejects.toThrow('持续占用')
  expect(attempts).toBe(8)
  expect(await readFile(f.target, 'utf8')).toBe('原记录')
  expect(await readFile(f.source, 'utf8')).toBe('新记录')
})
it('磁盘等其他错误立即停止，不尝试删除原记录', async () => {
  const f = await fixture()
  let attempts = 0
  await expect(
    replaceRecordFile(f.source, f.target, async () => {
      attempts++
      throw Object.assign(new Error('磁盘已满'), { code: 'ENOSPC' })
    }),
  ).rejects.toThrow('磁盘已满')
  expect(attempts).toBe(1)
  expect(await readFile(f.target, 'utf8')).toBe('原记录')
})
