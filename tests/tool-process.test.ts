import { describe, expect, it } from 'vitest'
import { runTool, redactToolLine } from '../src/main/services/tool-process'
import { delimiter, join } from 'node:path'

describe('工具进程', () => {
  it('实时接收回车进度、跨数据块中文和没有换行的末尾进度', async () => {
    const lines: string[] = []
    await runTool({
      executable: process.execPath,
      cwd: process.cwd(),
      signal: new AbortController().signal,
      args: [
        '-e',
        'const b=Buffer.from("语音检测"); process.stdout.write(b.subarray(0,2)); setTimeout(()=>{process.stdout.write(b.subarray(2)); process.stdout.write("\\rProgress: 42%\\r"); process.stderr.write("Processing video: 50%|###|");},30)',
      ],
      onLine: (line) => lines.push(line),
    })
    expect(lines).toContain('语音检测')
    expect(lines).toContain('Progress: 42%')
    expect(lines).toContain('Processing video: 50%|###|')
  })
  it('仅为当前子进程追加运行库搜索目录，不改变父进程环境', async () => {
    const before = { ...process.env }
    const directory = join(process.cwd(), '中文运行库')
    const result = await runTool({
      executable: process.execPath,
      cwd: process.cwd(),
      signal: new AbortController().signal,
      pathEntries: [directory],
      args: ['-e', 'console.log(process.env.PATH)'],
    })
    expect(result.code).toBe(0)
    expect(result.stdout.startsWith(directory + delimiter)).toBe(true)
    expect(process.env).toEqual(before)
    await expect(
      runTool({
        executable: process.execPath,
        cwd: process.cwd(),
        signal: new AbortController().signal,
        pathEntries: [directory + delimiter + '其他目录'],
        args: [],
      }),
    ).rejects.toThrow('工具参数无效')
  })
  it('参数以数组原样传递，不解释 shell；接收中文输出及真实退出码', async () => {
    const literal = '中文 & echo 不应执行 | $() ; " 引号'
    const lines: string[] = []
    const result = await runTool({
      executable: process.execPath,
      cwd: process.cwd(),
      signal: new AbortController().signal,
      args: [
        '-e',
        'process.stdout.write(process.argv[1]); process.stderr.write("中文错误\\n"); process.exitCode=7',
        literal,
      ],
      onLine: (line) => lines.push(line),
    })
    expect(result).toEqual({ code: 7, stdout: literal, stderr: '中文错误\n' })
    expect(lines).toContain('中文错误')
  })
  it.each(['超时', '取消'])(
    '停止挂起进程及子进程：%s',
    async (mode) => {
      const controller = new AbortController()
      let child = 0
      const work = runTool({
        executable: process.execPath,
        cwd: process.cwd(),
        signal: controller.signal,
        timeoutMs: mode === '超时' ? 900 : 10000,
        args: [
          '-e',
          'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{windowsHide:true,stdio:"ignore"}); console.log(c.pid); setInterval(()=>{},1000)',
        ],
        onLine: (line) => {
          child = Number(line)
          if (mode === '取消') controller.abort()
        },
      })
      await expect(work).rejects.toThrow(mode)
      expect(child).toBeGreaterThan(0)
      expect(() => process.kill(child, 0)).toThrow()
    },
    15000,
  )
  it('工具输出过滤凭据、授权头、URL 查询和控制字符', () => {
    const line = redactToolLine(
      '\u001b[31mtoken=敏感 password="含 空格" {"api_key":"隐藏"} Bearer abc https://user:pass@example.org/a?token=hidden',
    )
    for (const word of ['敏感', '含 空格', '隐藏"', 'abc', 'user:pass', '?token', '\u001b'])
      expect(line).not.toContain(word)
    expect(line).toContain('https://example.org/a')
    expect(redactToolLine('[1;31mCUDA 加载失败[m')).toBe('CUDA 加载失败')
    expect(redactToolLine('\u001b[0;93m警告\u001b[m')).toBe('警告')
    expect(redactToolLine('文件[123].mkv')).toBe('文件[123].mkv')
  })
})
