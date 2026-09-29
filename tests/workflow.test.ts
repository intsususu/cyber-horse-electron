import { describe, expect, it } from 'vitest'
import { emptyRun, isRunning, runReducer } from '../src/renderer/src/lib/workflow'

const tasks = [
  { id: 'prepare', title: '整理' },
  { id: 'scrape', title: '刮削' },
  { id: 'archive', title: '归档' },
]
const start = () => runReducer(emptyRun, { type: 'start', tasks, id: 1, now: '10:00:00' })

describe('流程演示的用户行为', () => {
  it('冻结所选文件范围，并拒绝空步骤启动', () => {
    const files = [
      { name: 'a.mp4', path: 'C:/a.mp4', relativePath: 'a.mp4', size: 10, modifiedAt: 0 },
    ]
    const state = runReducer(emptyRun, {
      type: 'start',
      tasks,
      id: 1,
      now: '',
      scope: { files, source: '手动选择' },
    })
    files[0]!.name = 'b.mp4'
    expect(state.scope?.files[0]?.name).toBe('a.mp4')
    expect(runReducer(emptyRun, { type: 'start', tasks: [], id: 2, now: '' })).toBe(emptyRun)
  })
  it('保持串行，仅在当前步骤完成后开始下一步', () => {
    let state = start()
    expect(state.tasks.map((task) => task.status)).toEqual(['running', 'pending', 'pending'])
    for (let index = 0; index < 9; index++)
      state = runReducer(state, { type: 'tick', now: '10:00:01' })
    expect(state.tasks[0]?.progress).toBe(90)
    expect(state.tasks[1]?.startedAt).toBeUndefined()
    state = runReducer(state, { type: 'tick', now: '10:00:06' })
    expect(state.tasks.map((task) => task.status)).toEqual(['succeeded', 'running', 'pending'])
    expect(state.tasks[0]?.endedAt).toBe('10:00:06')
    expect(state.tasks[1]?.startedAt).toBe('10:00:06')
    for (let index = 0; index < 20; index++)
      state = runReducer(state, { type: 'tick', now: '10:00:18' })
    expect(state.tasks.every((task) => task.status === 'succeeded' && task.progress === 100)).toBe(
      true,
    )
    expect(isRunning(state)).toBe(false)
  })
  it('运行中拒绝重复启动和清空', () => {
    const state = start()
    expect(runReducer(state, { type: 'start', tasks: [], id: 2, now: '' })).toBe(state)
    expect(runReducer(state, { type: 'clear' })).toBe(state)
  })
  it('取消后停止所有待执行步骤，后续计时不再推进', () => {
    const state = runReducer(start(), { type: 'cancel', now: '10:00:02' })
    expect(isRunning(state)).toBe(false)
    expect(state.tasks.every((task) => task.status === 'cancelled')).toBe(true)
    expect(runReducer(state, { type: 'tick', now: '10:01:00' })).toBe(state)
    expect(runReducer(state, { type: 'clear' })).toEqual(emptyRun)
  })
  it('完成后再次运行重置旧进度和时间', () => {
    let state = start()
    for (let index = 0; index < 30; index++)
      state = runReducer(state, { type: 'tick', now: '10:00:20' })
    state = runReducer(state, { type: 'start', tasks: [tasks[0]!], id: 2, now: '11:00:00' })
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({ progress: 0, status: 'running', startedAt: '11:00:00' })
    expect(state.tasks[0]?.endedAt).toBeUndefined()
  })
})
