import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { defaultSettings } from '../src/shared/contracts'
import { EmbyClient } from '../src/main/services/emby-client'
import { MediaDownloads } from '../src/main/services/media-downloads'

it('真实 HTTP 下载持续超过 20 秒仍完整发布文件', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'horse-download-stream-')))
  const settings = structuredClone(defaultSettings)
  settings.paths.download = join(root, 'download')
  await mkdir(settings.paths.download)
  settings.mediaServer.username = '隔离测试用户'
  const chunk = Buffer.alloc(1024, 7)
  const count = 23
  let streamStarted = 0
  const server = createServer((request, response) => {
    if (request.url?.includes('AuthenticateByName')) {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ AccessToken: 'isolated-test-token', User: { Id: 'u1' } }))
    } else if (request.url?.includes('/Items/v1')) {
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({
          Id: 'v1',
          Name: '隔离视频',
          MediaSources: [
            { Id: 's1', Path: '/test/ABC-123.mp4', Container: 'mp4', Size: chunk.length * count },
          ],
        }),
      )
    } else if (request.url?.includes('/Videos/v1/stream')) {
      streamStarted = Date.now()
      response.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': chunk.length * count,
      })
      response.write(chunk)
      let sent = 1
      const timer = setInterval(() => {
        response.write(chunk)
        if (++sent === count) {
          clearInterval(timer)
          response.end()
        }
      }, 1000)
      response.on('close', () => clearInterval(timer))
    } else {
      response.writeHead(404).end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('隔离服务器未启动。')
  settings.mediaServer.serverUrl = `http://127.0.0.1:${address.port}`
  const client = new EmbyClient(
    async () => settings,
    async () => '测试密码',
  )
  const downloads = new MediaDownloads(join(root, 'data'), [], client, async () => settings)
  try {
    await downloads.start('v1', 's1')
    await expect.poll(() => downloads.running, { timeout: 28000, interval: 100 }).toBe(false)
    const [job] = await downloads.snapshot()
    expect(job?.status, job?.message).toBe('completed')
    expect(Date.now() - streamStarted).toBeGreaterThan(20000)
    expect(job?.received).toBe(chunk.length * count)
    expect(await readFile(job!.path)).toEqual(Buffer.concat(Array(count).fill(chunk)))
  } finally {
    await downloads.stop()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}, 35000)
