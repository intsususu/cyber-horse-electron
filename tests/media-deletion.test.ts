import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaDetail, MediaDownload, MediaProcessState } from '../src/shared/media-library'
import { MediaDeletion } from '../src/main/services/media-deletion'

function fixture() {
  const client = {
    detail: vi.fn(async () => ({ name: '测试影片', canDelete: true }) as MediaDetail),
    generation: 1,
    delete: vi.fn(async () => {}),
  }
  const downloads = { snapshot: vi.fn(async (): Promise<MediaDownload[]> => []) }
  const processes = { snapshot: vi.fn((): MediaProcessState[] => []) }
  return { client, downloads, processes, deletion: new MediaDeletion(client, downloads, processes) }
}

afterEach(() => vi.restoreAllMocks())

describe('应用内媒体删除确认', () => {
  it('预检返回服务器标题，不删除；只有一次有效确认能提交删除', async () => {
    const f = fixture()
    const confirmation = await f.deletion.prepare('v1')
    expect(confirmation).toMatchObject({ id: 'v1', name: '测试影片' })
    expect(f.client.delete).not.toHaveBeenCalled()
    await expect(f.deletion.confirm('v1')).rejects.toThrow('失效')
    await expect(f.deletion.confirm(confirmation.token)).resolves.toBe(true)
    expect(f.client.delete).toHaveBeenCalledExactlyOnceWith('v1', 1)
    await expect(f.deletion.confirm(confirmation.token)).rejects.toThrow('失效')
  })

  it('新确认使旧确认失效，过期确认不能删除', async () => {
    const f = fixture()
    const first = await f.deletion.prepare('v1')
    const second = await f.deletion.prepare('v2')
    await expect(f.deletion.confirm(first.token)).rejects.toThrow('失效')
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60 * 1000)
    await expect(f.deletion.confirm(second.token)).rejects.toThrow('失效')
    expect(f.client.delete).not.toHaveBeenCalled()
  })

  it('账号无权限时不生成确认', async () => {
    const f = fixture()
    f.client.detail.mockResolvedValue({ name: '测试影片', canDelete: false } as MediaDetail)
    await expect(f.deletion.prepare('v1')).rejects.toThrow('权限')
    expect(f.client.delete).not.toHaveBeenCalled()
  })

  it('确认期间服务器连接变化时拒绝删除', async () => {
    const f = fixture()
    const confirmation = await f.deletion.prepare('v1')
    f.client.generation++
    await expect(f.deletion.confirm(confirmation.token)).rejects.toThrow('连接已变化')
    expect(f.client.delete).not.toHaveBeenCalled()
  })

  it.each(['running', 'cancelling'] as const)('下载%s时预检及确认都拒绝删除', async (status) => {
    const f = fixture()
    const confirmation = await f.deletion.prepare('v1')
    f.downloads.snapshot.mockResolvedValue([{ itemId: 'v1', status } as MediaDownload])
    await expect(f.deletion.confirm(confirmation.token)).rejects.toThrow('正在下载')
    await expect(f.deletion.prepare('v1')).rejects.toThrow('正在下载')
    expect(f.client.delete).not.toHaveBeenCalled()
  })

  it.each(['pending', 'running'] as const)('复合任务%s时预检及确认都拒绝删除', async (status) => {
    const f = fixture()
    const confirmation = await f.deletion.prepare('v1')
    f.processes.snapshot.mockReturnValue([{ itemId: 'v1', status } as MediaProcessState])
    await expect(f.deletion.confirm(confirmation.token)).rejects.toThrow('排队处理')
    await expect(f.deletion.prepare('v1')).rejects.toThrow('排队处理')
    expect(f.client.delete).not.toHaveBeenCalled()
  })

  it('确认或预检尚未完成时，拒绝重复提交', async () => {
    const f = fixture()
    let finish!: () => void
    f.client.delete.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)))
    const confirmation = await f.deletion.prepare('v1')
    const deleting = f.deletion.confirm(confirmation.token)
    await expect(f.deletion.confirm(confirmation.token)).rejects.toThrow('当前删除操作')
    await expect(f.deletion.prepare('v2')).rejects.toThrow('当前删除操作')
    finish()
    await deleting
    expect(f.client.delete).toHaveBeenCalledTimes(1)
  })
})
