import { describe, it, expect } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { defaultSettings, parseStoredSettings } from '../src/shared/contracts'
import { PipelineTools } from '../src/main/services/pipeline-tools'
import { runTool, redactToolLine } from '../src/main/services/tool-process'
import { WorkspaceTasks } from '../src/main/services/workspace-tasks'
import { exists } from '../src/main/services/safe-files'

// 只在显式给出本机配置时运行；所有媒体由测试生成，失败样本留在忽略的结果目录。
describe.skipIf(!process.env.CYBER_HORSE_REAL_SETTINGS)('真实工具隔离小样本', () => {
  it(
    '验证任务目录参数、字幕封装和当前 MDC 标记；保留各工具真实结果',
    async () => {
      const configured = parseStoredSettings(
        JSON.parse(await readFile(process.env.CYBER_HORSE_REAL_SETTINGS!, 'utf8')),
      )
      const settings = structuredClone(defaultSettings)
      for (const key of ['whisper', 'mkvmerge', 'jasna', 'mdc'] as const)
        settings.paths[key] = configured.paths[key]
      const root = resolve('test-results', '真实工具-' + Date.now())
      await mkdir(root, { recursive: true })
      for (const key of [
        'download',
        'preprocess',
        'nas',
        'whisperOutput',
        'videoOutput',
        'mdcOutput',
      ] as const) {
        settings.paths[key] = join(root, key)
        await mkdir(settings.paths[key])
      }
      const outcomes: { name: string; state: string; message: string }[] = []
      const tools = new PipelineTools()
      const log: string[] = []
      const signal = () => AbortSignal.timeout(180000)
      const record = async (name: string, action: () => Promise<void>) => {
        try {
          await action()
          outcomes.push({ name, state: '通过', message: '' })
        } catch (error) {
          outcomes.push({
            name,
            state: '失败',
            message: error instanceof Error ? error.message : '验证失败',
          })
        }
        await writeFile(join(root, '验证结果.json'), JSON.stringify(outcomes, null, 2) + '\n')
        await writeFile(join(root, '工具日志.txt'), log.map(redactToolLine).join('\n') + '\n')
      }
      for (const step of ['subtitle-mux', 'video', 'scrape'] as const)
        await record(step + ' 参数检查', async () => {
          await tools.check(settings, [step], signal(), true)
        })
      const checked = await tools.check(settings, ['video'], signal(), true)
      const ffmpeg = join(dirname(checked.ffprobe!.path), 'ffmpeg.exe')
      if (!(await exists(ffmpeg))) throw new Error('合成样本需要 ffprobe 同目录的 ffmpeg。')
      const sample = join(root, '合成样本.mp4')
      const generated = await runTool({
        executable: ffmpeg,
        cwd: root,
        args: [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=blue:s=320x240:r=25:d=4',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=4',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-shortest',
          sample,
        ],
        signal: signal(),
      })
      expect(generated.code, generated.stderr).toBe(0)
      const source = join(settings.paths.preprocess, 'TEST-001.mp4')
      const { copyFile } = await import('node:fs/promises')
      await copyFile(sample, source)
      const srt = join(settings.paths.preprocess, 'TEST-001.srt')
      await writeFile(srt, '1\n00:00:00,000 --> 00:00:02,000\n人工生成的中文字幕测试\n')
      const tasks = new WorkspaceTasks(join(root, '应用数据'), [], async () => settings, tools)
      await record('真实字幕封装、发布与清理', async () => {
        const id = await tasks.enqueue(
          settings,
          {
            origin: 'workbench',
            steps: ['subtitle-mux'],
            files: [{ path: source, companions: [srt] }],
            destination: { kind: 'preprocess', root: settings.paths.preprocess },
          },
          [settings.paths.preprocess],
        )
        const state = await tasks.wait(id)
        if (state?.state !== 'completed') throw new Error(state?.message ?? '未完成')
        const result = await tools.inspect(
          checked,
          join(settings.paths.preprocess, 'TEST-001-C.mkv'),
          signal(),
        )
        expect(result).toMatchObject({ chinese: true, audio: true })
      })
      const variants = (process.env.CYBER_HORSE_MDC_VARIANTS ?? 'C,hack,UC,UC_1').split(',')
      if (variants.some((value) => !['C', 'hack', 'UC', 'UC_1'].includes(value)))
        throw new Error('MDC 验证标记无效。')
      for (const suffix of variants)
        await record('真实 MDC ' + suffix, async () => {
          const path = join(settings.paths.preprocess, `CLUB-494-${suffix}.mp4`)
          await copyFile(sample, path)
          const id = await tasks.enqueue(
            settings,
            {
              origin: 'workbench',
              steps: ['scrape'],
              files: [{ path }],
              destination: { kind: 'preprocess', root: settings.paths.preprocess },
            },
            [settings.paths.preprocess],
          )
          const timeout = setTimeout(() => tasks.cancel(id), 300000)
          try {
            const state = await tasks.wait(id)
            log.push(...(tasks.project(id)?.logs.map((entry) => entry.text) ?? []))
            if (state?.state !== 'completed') throw new Error(state?.message ?? '未完成')
          } finally {
            clearTimeout(timeout)
          }
        })
      await tasks.stop()
      expect(
        outcomes.filter((value) => value.state === '失败'),
        JSON.stringify(outcomes),
      ).toEqual([])
    },
    15 * 60 * 1000,
  )
})
