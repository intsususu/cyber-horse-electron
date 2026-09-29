import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CredentialStore } from '../src/main/services/credential-store'

const encryptor = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value.split('').reverse().join(''), 'utf8'),
  decryptString: (value: Buffer) => value.toString('utf8').split('').reverse().join(''),
}

describe('媒体服务器凭据', () => {
  it('密码不进入普通配置文件，可保存、检查和清除', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'cyber-horse-credential-'))
    const store = new CredentialStore(folder, encryptor)
    expect(await store.hasPassword()).toBe(false)
    await store.savePassword('仅用于测试的密码')
    expect(await store.hasPassword()).toBe(true)
    expect(await readFile(join(folder, 'media-server-credential.bin'), 'utf8')).not.toContain(
      '仅用于测试的密码',
    )
    expect(await readdir(folder)).toEqual(['media-server-credential.bin'])
    await store.savePassword('')
    expect(await store.hasPassword()).toBe(false)
  })
  it('安全存储不可用时不落盘', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'cyber-horse-credential-'))
    const store = new CredentialStore(folder, { ...encryptor, isEncryptionAvailable: () => false })
    await expect(store.savePassword('仅用于测试的密码')).rejects.toThrow('系统安全存储暂不可用')
    expect(await readdir(folder)).toEqual([])
  })
})
