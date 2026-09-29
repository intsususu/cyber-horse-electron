import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MediaDownload, MediaProcessState } from '../src/shared/media-library'
import { MediaProcessTask } from '../src/renderer/src/components/MediaDownloadTasks'
import { buildTaskQueue, queueGroups, queueTab } from '../src/renderer/src/lib/task-queue'
import type { DemoTask } from '../src/renderer/src/lib/workflow'

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
    expect(html).toContain('执行记录位置')
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
