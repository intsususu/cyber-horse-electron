import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export class MediaPlaybackLog {
  readonly path: string
  private pending: Promise<void> = Promise.resolve()

  constructor(private directory: string) {
    this.path = join(directory, 'media-playback.log')
  }

  record(event: string, details: Record<string, string | number | boolean | null>): Promise<void> {
    const line = JSON.stringify({ time: new Date().toISOString(), event, ...details }) + '\n'
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true })
        const size = await stat(this.path)
          .then((value) => value.size)
          .catch(() => 0)
        if (size + Buffer.byteLength(line) > 1024 * 1024)
          await writeFile(this.path, line, { encoding: 'utf8' })
        else await appendFile(this.path, line, { encoding: 'utf8' })
      })
    this.pending = operation
    return operation
  }
}
