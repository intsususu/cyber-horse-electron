import { describe, expect, it } from 'vitest'
import type { PipelineProgress } from '../src/shared/pipeline'
import { toolProgress } from '../src/main/services/tool-progress'

describe('外部工具进度解析', () => {
  it('Whisper 区分分块语音检测与识别位置，时间戳倒退不倒退识别进度', () => {
    const values: PipelineProgress[] = []
    const read = toolProgress('whisper', (value) => values.push(value), 120)
    expect(read('VAD进度：1/4 块（25.0%）在 cuda 上')).toBe(true)
    read('[00:30.00 --> 01:00.00] 中文')
    read('[00:20.00 --> 00:40.00] 时间轴重叠')
    read('VAD progress: 1/2 chunks (50.0%) on cpu')
    read('[01:59.00 --> 02:00.00] 末尾')
    expect(values).toEqual([
      { phase: 'vad', percent: 25 },
      { phase: 'transcribe', percent: 50, approximate: true },
      { phase: 'transcribe', percent: 50, approximate: true },
      { phase: 'vad', percent: 50 },
      { phase: 'transcribe', percent: 99, approximate: true },
    ])
  })
  it('Whisper 无可靠总时长时不填零，支持长视频时间戳', () => {
    const values: PipelineProgress[] = []
    toolProgress('whisper', (p) => values.push(p))('[01:00:00.00 --> 01:10:00.00] 中文')
    expect(values[0]).toEqual({ phase: 'transcribe', percent: null, approximate: true })
  })
  it('Jasna 读取真实帧处理百分比、速度与预计剩余时间，并清理控制符', () => {
    const values: PipelineProgress[] = []
    const read = toolProgress('jasna', (p) => values.push(p))
    read(
      '\x1b[32mProcessing video: 42%|####|Processed: 1:23 (2848f) | Remaining: 1:02:03 (5000f) | Speed: 35.0fps\x1b[0m',
    )
    read('Processing video: 40%|####|Processed: 1:23 (2848f) | Remaining: ? | Speed: ?')
    expect(values).toEqual([
      { phase: 'restore', percent: 42, fps: 35, etaSeconds: 3723 },
      { phase: 'restore', percent: 42 },
    ])
  })
  it('mkvmerge 识别机器输出与本地化输出，每次调用独立重置', () => {
    const values: PipelineProgress[] = []
    const read = toolProgress('mkvmerge', (p) => values.push(p))
    read('#GUI#progress 42%')
    read('Progress: 100%')
    toolProgress('mkvmerge', (p) => values.push(p))('进度：1%')
    expect(values.map((p) => p.percent)).toEqual([42, 100, 1])
  })
  it.each(['whisper', 'jasna', 'mkvmerge'] as const)(
    '%s 忽略无关百分比、错误消息和非法数值',
    (tool) => {
      const values: PipelineProgress[] = []
      const read = toolProgress(tool, (p) => values.push(p), 100)
      for (const line of [
        '模型下载 80%',
        'Error: Progress: 100%',
        'VAD进度：1/0 块',
        'VAD进度：3/2 块',
        '[00:61.00 --> 00:62.00] 无效时间',
        '[00:40.00 --> 00:30.00] 倒置',
        'Processing video: 101%|###|',
        '#GUI#progress 101%',
      ])
        expect(read(line)).toBe(false)
      expect(values).toEqual([])
    },
  )
})
