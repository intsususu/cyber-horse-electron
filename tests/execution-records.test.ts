import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm, rmdir, symlink, realpath } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { ExecutionRecords } from '../src/main/services/execution-records'
import type { ExecutionRecordRequest } from '../src/shared/execution-record'

const taskId = '7bdccbe5-d0f9-4f57-8688-118a3a52f25a'
const pipelineId = 'b251e747-81b7-4399-ae84-408a7750d183'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (resolve(root) !== root || !basename(root).startsWith('horse-records-'))
      throw new Error('测试清理路径无效')
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'horse-records-')))
  roots.push(root)
  for (const directory of ['media-process', 'pipeline', 'preparation'])
    await mkdir(join(root, directory))
  const opened = vi.fn(async (_path: string) => '')
  const service = new ExecutionRecords(root, opened)
  const save = async (kind: string, id: string, entries: unknown[]) => {
    const path = join(root, kind, `${id}.jsonl`)
    await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    return path
  }
  return { root, opened, service, save }
}

describe('打开执行记录与日志', () => {
  it('合并关联处理日志和旧记录内的日志，去重、脱敏且不修改原文件', async () => {
    const f = await fixture()
    const entry = {
      time: '2026-09-30T02:00:00Z',
      level: 'info',
      text: '开始视频处理 token=不可泄露',
    }
    const source = await f.save('media-process', taskId, [
      {
        type: '结果',
        record: {
          status: 'failed',
          password: '旧密码',
          pipeline: {
            id: pipelineId,
            journal: '../不能使用的路径',
            logs: [entry, { ...entry, time: '2026-09-30T02:00:01Z', text: '旧记录中的 MDC 诊断' }],
          },
        },
      },
    ])
    await f.save('pipeline', pipelineId, [
      { type: 'log', entry },
      { type: 'finished', message: '工具处理失败' },
    ])
    const original = await readFile(source, 'utf8')
    await f.service.open({ kind: 'media-process', id: taskId })
    const path = f.opened.mock.calls[0]![0]
    expect(path).toBe(join(f.root, 'execution-records', `media-process-${taskId}.txt`))
    const text = await readFile(path, 'utf8')
    const logSection = text.split('【执行日志】')[1]!.split('【主任务执行事件】')[0]!
    expect(logSection.match(/开始视频处理/g)).toHaveLength(1)
    expect(logSection).toContain('旧记录中的 MDC 诊断')
    expect(text).toContain('工具处理失败')
    expect(text).not.toContain('不可泄露')
    expect(text).not.toContain('旧密码')
    expect(await readFile(source, 'utf8')).toBe(original)
  })
  it('运行中从持久化关联标识读取日志，重新打开刷新同一文本快照', async () => {
    const f = await fixture()
    await f.save('media-process', taskId, [{ type: '处理记录', pipelineId }])
    const path = await f.save('pipeline', pipelineId, [
      { type: 'log', entry: { text: '第一条日志' } },
    ])
    await f.service.open({ kind: 'media-process', id: taskId })
    const report = f.opened.mock.calls[0]![0]
    expect(await readFile(report, 'utf8')).toContain('第一条日志')
    await writeFile(path, JSON.stringify({ type: 'log', entry: { text: '追加后的日志' } }) + '\n')
    await f.service.open({ kind: 'media-process', id: taskId })
    expect(f.opened.mock.calls[1]![0]).toBe(report)
    expect(await readFile(report, 'utf8')).toContain('追加后的日志')
  })
  it('损坏行、关联文件缺失与工具日志截断明确提示，保留可读部分', async () => {
    const f = await fixture()
    const path = await f.save('media-process', taskId, [
      { type: '处理记录', pipelineId },
      { type: '日志', entry: { text: '已保存的主任务日志' } },
      { type: 'log-truncated', message: '工具日志达到上限，后续文本未保存。' },
    ])
    await writeFile(path, (await readFile(path, 'utf8')) + '{未写完')
    await f.service.open({ kind: 'media-process', id: taskId })
    const report = await readFile(f.opened.mock.calls[0]![0], 'utf8')
    expect(report).toContain('部分记录行损坏或尚未写完')
    expect(report).toContain('无法读取，保留主记录中已有的日志')
    expect(report).toContain('已保存的主任务日志')
    expect(report).toContain('工具日志达到上限')
  })
  it('拒绝路径参数、非法标识、缺失记录和链接目录', async () => {
    const f = await fixture()
    for (const request of [
      { kind: 'pipeline', id: '../settings' },
      { kind: '../pipeline', id: taskId },
      { kind: 'pipeline', id: taskId, path: 'C:/Windows/notepad.exe' },
    ])
      await expect(f.service.open(request as ExecutionRecordRequest)).rejects.toThrow('标识无效')
    await expect(f.service.open({ kind: 'pipeline', id: taskId })).rejects.toThrow(
      '无法读取执行记录',
    )
    const outside = await mkdtemp(join(tmpdir(), 'horse-records-'))
    roots.push(outside)
    await writeFile(join(outside, `${taskId}.jsonl`), '{}\n')
    await rmdir(join(f.root, 'pipeline'))
    await symlink(outside, join(f.root, 'pipeline'), 'junction')
    await expect(f.service.open({ kind: 'pipeline', id: taskId })).rejects.toThrow(
      '无法读取执行记录',
    )
    expect(f.opened).not.toHaveBeenCalled()
  })
  it('系统打开失败返回中文错误，预处理与四步使用相同入口', async () => {
    const f = await fixture()
    for (const kind of ['pipeline', 'preparation'] as const) {
      await f.save(kind, taskId, [{ type: 'completed', message: '执行成功' }])
      await f.service.open({ kind, id: taskId })
    }
    f.opened.mockResolvedValue('没有关联程序')
    await expect(f.service.open({ kind: 'preparation', id: taskId })).rejects.toThrow(
      'TXT 默认打开程序',
    )
  })
})
