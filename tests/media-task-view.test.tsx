import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MediaDownload, MediaProcessState } from '../src/shared/media-library'
import {
  MediaDownloadTask,
  MediaProcessTask,
} from '../src/renderer/src/components/MediaDownloadTasks'
import { TaskDuration, TaskTiming } from '../src/renderer/src/components/TaskTiming'
import { taskDuration } from '../src/renderer/src/lib/task-time'
import { buildTaskQueue, queueGroups, queueTab } from '../src/renderer/src/lib/task-queue'
import type { DemoTask } from '../src/renderer/src/lib/workflow'
import type { TaskView } from '../src/shared/task-workspace'
import { workspaceTaskDownload } from '../src/renderer/src/lib/task-queue'
import {
  WorkspaceTaskCard,
  workspaceTaskTab,
} from '../src/renderer/src/components/WorkspaceTaskCard'

const download: MediaDownload = {
  id: 'download-1',
  itemId: 'movie-1',
  sourceId: 'source-1',
  name: '测试影片',
  status: 'completed',
  received: 1024,
  total: 1024,
  path: 'C:\\测试\\影片.mp4',
  temporary: '',
  message: '下载完成。',
  started: '2026-09-28T10:00:00.000Z',
  ended: '2026-09-28T10:01:00.000Z',
}
const process: MediaProcessState = {
  id: 'process-1',
  itemId: 'movie-1',
  sourceId: 'source-1',
  name: '测试影片',
  kind: 'subtitle',
  original: 'C:\\测试\\影片.mp4',
  affected: [],
  steps: ['提取中文字幕并封装', 'MDC 元数据刮削'],
  status: 'running',
  message: '正在处理本次下载的文件。',
  downloadId: download.id,
  journal: 'C:\\测试\\执行记录.jsonl',
  pipeline: {
    id: 'pipeline-1',
    status: 'running',
    startedAt: '2026-09-28T10:01:00.000Z',
    tasks: [
      {
        id: 'subtitle-mux',
        title: '字幕与封装',
        status: 'running',
        completed: 0,
        total: 1,
        skipped: 0,
        progress: 0,
        current: { phase: 'transcribe', percent: 42 },
        message: '正在识别字幕。',
      },
    ],
    files: [],
    source: '',
    mode: 'selected',
    logs: [{ id: 1, time: '10:01:00', level: 'info', text: '工具诊断输出' }],
    message: '处理中',
    journal: '',
    outputs: [],
    resultFiles: [],
  },
}

describe('媒体库复合任务视图', () => {
  const workspaceView = (): TaskView => ({
    task: {
      version: 1,
      revision: 0,
      updatedAt: '2026-09-28T10:03:00.000Z',
      downloadRoot: 'C:/测试',
      workspaceName: '任务',
      steps: ['archive'],
      message: '处理完成。',
      id: 'workspace-1',
      name: 'CLUB-388_1个文件',
      origin: 'media-library',
      createdAt: '2026-09-28T10:02:00.000Z',
      state: 'completed',
      context: null,
      destination: { kind: 'media-original', root: 'C:/NAS' },
      files: [
        {
          id: 'file-1',
          name: '影片.mp4',
          directory: '文件',
          number: null,
          artifacts: [],
          marks: {
            chinese: { present: false, evidence: 'none' },
            restored: { present: false, evidence: 'none' },
          },
          sources: [
            {
              path: download.path,
              copy: false,
              stamp: { size: 1024, mtimeMs: 0, ctimeMs: 0, ino: 1, dev: 1 },
              target: '文件/影片.mp4',
              state: 'claimed',
            },
          ],
          steps: [],
          publications: [],
        },
      ],
    },
    directory: '',
    active: false,
    recoverable: false,
    diagnostic: '',
  })

  it('重启后复合记录丢失时，旧任务按完整来源合并下载并保留原影片标题与下载详情', () => {
    const view = workspaceView()
    expect(buildTaskQueue([], [download], [], [view])).toEqual([])
    const matched = workspaceTaskDownload(view, [download])
    const html = renderToStaticMarkup(
      <WorkspaceTaskCard
        view={view}
        download={matched}
        busy={false}
        act={() => {}}
        open={() => {}}
        cancel={() => {}}
      />,
    )
    expect(html).toContain('测试影片')
    expect(html).not.toContain('CLUB-388_1个文件')
    expect(html).toContain('下载：')
    expect(html.match(/<article/g)).toHaveLength(1)
  })
  it('新任务持久化下载 ID，改路径或同名记录也只关联对应下载', () => {
    const view = workspaceView()
    view.task.context = {
      configuration: '',
      replacements: [],
      sync: null,
      media: { processId: process.id, downloadId: download.id, name: '原影片名称' },
    }
    const independent = { ...download, id: 'independent', path: 'C:/另一份/影片.mp4' }
    expect(
      buildTaskQueue(
        [],
        [download, independent],
        [{ ...process, workspaceTaskId: view.task.id }],
        [view],
      ).map((entry) => entry.task.id),
    ).toEqual(['independent'])
    expect(workspaceTaskDownload(view, [{ ...download, path: 'C:/迁移/影片.mp4' }])?.id).toBe(
      download.id,
    )
  })
  it('永久删除后不进入任何分组，关联下载和处理记录也不重新出现', () => {
    const view = workspaceView()
    view.task.state = 'removed'
    view.task.removalAction = 'delete'
    expect(workspaceTaskTab(view)).toBeNull()
    expect(
      buildTaskQueue([], [download], [{ ...process, workspaceTaskId: view.task.id }], [view]),
    ).toEqual([])
    view.recoverable = true
    view.directory = 'C:/测试/.work/任务'
    expect(workspaceTaskTab(view)).toBe('unfinished')
    view.active = true
    expect(workspaceTaskTab(view)).toBe('active')
  })
  it('兼容旧删除记录，保留文件的记录仍可查看', () => {
    const view = workspaceView()
    view.task.state = 'removed'
    view.task.message = '任务内已识别文件已按用户确认永久删除。'
    expect(workspaceTaskTab(view)).toBeNull()
    view.task.removalAction = 'keep'
    expect(workspaceTaskTab(view)).toBe('completed')
  })
  it('同名独立下载、较晚下载和有歧义的旧路径不被误合并', () => {
    const view = workspaceView()
    for (const jobs of [
      [{ ...download, path: 'C:/其他/影片.mp4' }],
      [{ ...download, ended: '2026-09-29T10:01:00.000Z' }],
      [download, { ...download, id: 'duplicate' }],
    ])
      expect(buildTaskQueue([], jobs, [], [view])).toHaveLength(jobs.length)
  })
  it('只在主视图展开当前步骤，等待和已结束的步骤放入详情', () => {
    const html = renderToStaticMarkup(
      <MediaProcessTask
        job={{
          ...process,
          pipeline: {
            ...process.pipeline!,
            tasks: [
              ...process.pipeline!.tasks,
              {
                ...process.pipeline!.tasks[0]!,
                id: 'scrape',
                title: '元数据刮削',
                status: 'pending',
                current: undefined,
              },
            ],
          },
        }}
        onError={() => {}}
      />,
    )
    expect(html.split('<details')[0]).toContain('字幕识别 42%')
    expect(html.split('<details')[0]).not.toContain('元数据刮削')
    expect(html.split('<details')[1]).toContain('元数据刮削')
  })

  it('显示字幕阶段的真实进度，把下载并入任务，处理日志留给折叠面板', () => {
    const html = renderToStaticMarkup(
      <MediaProcessTask download={download} job={process} onError={() => {}} />,
    )
    expect(html).toContain('字幕识别 42%')
    expect(html).toContain('aria-label="字幕与封装当前阶段进度" value="42"')
    expect(html).toContain('已完成 0/1 个文件')
    expect(html.match(/<article/g)).toHaveLength(1)
    expect(html).not.toContain('工具诊断输出')
    expect(html).toContain('起止时间与执行记录')
  })

  it('工具没有报告百分比时保持未定进度', () => {
    const unknown: MediaProcessState = {
      ...process,
      pipeline: {
        ...process.pipeline!,
        tasks: [
          {
            ...process.pipeline!.tasks[0]!,
            current: { phase: 'transcribe', percent: null },
          },
        ],
      },
    }
    const html = renderToStaticMarkup(<MediaProcessTask job={unknown} onError={() => {}} />)
    expect(html).toContain('字幕识别中…')
    expect(html).not.toContain('字幕识别 0%')
    expect(html).toContain('aria-label="字幕与封装当前阶段进度"')
    expect(html).not.toContain('aria-label="字幕与封装当前阶段进度" value=')
  })
})

describe('任务执行时间', () => {
  const start = '2026-09-28T23:59:30.000Z'
  const end = '2026-09-29T00:01:35.000Z'
  const timing = (status: string, endedAt?: string, now = Date.parse(end)) =>
    renderToStaticMarkup(
      <TaskTiming status={status} startedAt={start} endedAt={endedAt} now={now} />,
    )
  it('跨日保留日期，按完整时间戳计算耗时，结束后耗时固定', () => {
    const html = timing('completed', end)
    expect(html).toContain(`dateTime="${start}"`)
    expect(html).toContain(`dateTime="${end}"`)
    expect(html).toContain('耗时：2 分 5 秒')
    expect(timing('completed', end, Date.parse(end) + 3600000)).toBe(html)
    expect(taskDuration(Date.parse(start), Date.parse(start) + 90061000)).toBe(
      '1 天 1 小时 1 分 1 秒',
    )
  })
  it('运行和取消收尾期间随当前时间更新，失败和取消使用实际结束时间', () => {
    expect(timing('running')).toContain('已运行：2 分 5 秒')
    expect(timing('cancelling', undefined, Date.parse(end) + 1000)).toContain('已运行：2 分 6 秒')
    expect(timing('failed', end)).toContain('耗时：2 分 5 秒')
    expect(timing('cancelled', end)).toContain('耗时：2 分 5 秒')
    expect(taskDuration(0, 500)).toBe('不足 1 秒')
  })
  it('缺失、无效、逆序和中断确认时间不伪造耗时，未执行步骤不显示零秒', () => {
    for (const endedAt of [undefined, '无效时间', '2026-09-28T00:00:00Z'])
      expect(timing('failed', endedAt)).toContain('耗时：未记录')
    expect(timing('interrupted', end)).toContain('耗时：未记录')
    for (const status of ['pending', 'skipped', 'cancelled']) {
      const html = renderToStaticMarkup(<TaskTiming status={status} now={Date.parse(end)} />)
      expect(html).toContain(status === 'pending' ? '尚未开始' : '未执行')
      expect(html).not.toContain('耗时')
    }
    expect(
      renderToStaticMarkup(<TaskTiming status="completed" startedAt="无效" now={0} />),
    ).toContain('耗时：未记录')
  })
  it('复合任务主视图显示整体耗时，展开详情包含下载和每个已执行步骤的耗时', () => {
    const task = process.pipeline!.tasks[0]!
    const html = renderToStaticMarkup(
      <MediaProcessTask
        job={{
          ...process,
          status: 'completed',
          startedAt: download.started,
          endedAt: '2026-09-28T10:06:00Z',
          pipeline: {
            ...process.pipeline!,
            status: 'succeeded',
            tasks: [
              {
                ...task,
                status: 'succeeded',
                startedAt: '2026-09-28T10:01:00Z',
                endedAt: '2026-09-28T10:04:00Z',
              },
              {
                ...task,
                id: 'scrape',
                title: '元数据刮削',
                status: 'succeeded',
                startedAt: '2026-09-28T10:04:00Z',
                endedAt: '2026-09-28T10:05:00Z',
              },
            ],
          },
        }}
        download={download}
        onError={() => {}}
      />,
    )
    expect(html.split('<details')[0]).toContain('耗时：6 分')
    const details = html.split('<details')[1]!
    expect(details).toContain('耗时：3 分')
    expect(details.match(/耗时：1 分/g)).toHaveLength(2)
    expect(details).toContain('下载原文件')
    expect(details).not.toContain('开始：')
    expect(details).not.toContain('已完成 1/1 个文件')
    expect(html.split('<details')[2]).toContain('开始：')
    const standalone = renderToStaticMarkup(<MediaDownloadTask job={download} onError={() => {}} />)
    expect(standalone.split('<details')[0]).toContain('耗时：1 分')
  })
  it('旧任务缺少总时间时只展示一个占位，不使用子任务耗时冒充总耗时', () => {
    const html = renderToStaticMarkup(
      <MediaProcessTask
        job={{ ...process, status: 'completed' }}
        download={download}
        onError={() => {}}
      />,
    )
    const main = html.split('<details')[0]!
    expect(main).toContain('总耗时：—')
    expect(main).not.toContain('开始时间未记录')
    expect(main).not.toContain(process.message)
    expect(main).not.toContain('耗时：1 分')
    expect(renderToStaticMarkup(<TaskDuration status="pending" now={0} />)).toBe('')
  })
  it('精简成功说明时保留失败与取消原因', () => {
    for (const status of ['failed', 'cancelled'] as const) {
      const html = renderToStaticMarkup(
        <MediaProcessTask
          job={{ ...process, status, message: '输出校验未通过，源文件已保留。' }}
          onError={() => {}}
        />,
      )
      expect(html.split('<details')[0]).toContain('输出校验未通过，源文件已保留。')
    }
  })
})

describe('任务队列分组', () => {
  const tasks: DemoTask[] = [
    'succeeded',
    'running',
    'pending',
    'failed',
    'cancelled',
    'skipped',
  ].map((status, index) => ({
    id: `${index}`,
    title: `步骤 ${index}`,
    status: status as DemoTask['status'],
    progress: 0,
  }))
  it('运行项置于等待项之前，保留等待队列顺序，关联下载只计算一次', () => {
    const entries = buildTaskQueue(
      tasks,
      [download, { ...download, id: 'standalone', status: 'cancelling' }],
      [
        { ...process, id: 'waiting-1', status: 'pending' },
        process,
        { ...process, id: 'waiting-2', status: 'pending', downloadId: '' },
      ],
    )
    const groups = queueGroups(entries, 'active')
    expect(groups[0]!.entries.map((entry) => entry.id)).toEqual([
      'workbench:1',
      'process:process-1',
      'download:standalone',
    ])
    expect(groups[1]!.entries.map((entry) => entry.id)).toEqual([
      'workbench:2',
      'process:waiting-1',
      'process:waiting-2',
    ])
    expect(entries.filter((entry) => entry.kind === 'download')).toHaveLength(1)
  })
  it('成功移入已完成；失败、取消、中断和跳过不会伪装为成功', () => {
    const entries = buildTaskQueue(
      tasks,
      [download, { ...download, id: 'interrupted', status: 'interrupted' }],
      [{ ...process, status: 'failed', downloadId: '' }],
    )
    expect(
      entries.filter((entry) => queueTab(entry) === 'completed').map((entry) => entry.id),
    ).toEqual(['workbench:0', 'download:download-1'])
    expect(queueGroups(entries, 'unfinished')[0]!.entries.map((entry) => entry.id)).toEqual([
      'workbench:3',
      'workbench:4',
      'workbench:5',
      'process:process-1',
      'download:interrupted',
    ])
    const finished = buildTaskQueue([], [download], [{ ...process, status: 'completed' }])
    expect(queueGroups(finished, 'active')).toEqual([])
    expect(queueGroups(finished, 'completed')[0]!.entries).toHaveLength(1)
  })
})
