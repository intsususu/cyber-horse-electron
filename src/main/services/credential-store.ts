import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type Encryptor = {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export class CredentialStore {
  private readonly file: string
  private pending: Promise<void> = Promise.resolve()

  constructor(
    private readonly directory: string,
    private readonly encryptor: Encryptor,
  ) {
    this.file = join(directory, 'media-server-credential.bin')
  }

  async hasPassword(): Promise<boolean> {
    return Boolean(await this.readPassword())
  }

  // 仅主进程服务可读取；预加载不暴露此方法。
  async readPassword(): Promise<string> {
    await this.pending.catch(() => {})
    try {
      const encrypted = await readFile(this.file)
      if (!this.encryptor.isEncryptionAvailable()) throw new Error('系统安全存储暂不可用')
      return this.encryptor.decryptString(encrypted)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw new Error('无法读取已保存的媒体服务器密码，请检查此设备的安全存储')
    }
  }

  savePassword(password: string): Promise<void> {
    if (typeof password !== 'string' || password.length > 1024 || password.includes('\0'))
      throw new Error('密码格式无效或超过长度限制')
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        if (!password) {
          try {
            await unlink(this.file)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          return
        }
        if (!this.encryptor.isEncryptionAvailable())
          throw new Error('系统安全存储暂不可用，密码未保存')
        await mkdir(this.directory, { recursive: true })
        const temporary = `${this.file}.tmp`
        await writeFile(temporary, this.encryptor.encryptString(password))
        await rename(temporary, this.file)
      })
    this.pending = operation
    return operation
  }
}
