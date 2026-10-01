import { ipcMain, screen, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { channels } from '../shared/channels'
import { vlcControlSchema, vlcOpenSchema } from '../shared/vlc-player'
import { VlcPlayer, type VlcWindow } from './services/vlc-player'
import type { SettingsStore } from './services/settings-store'
import type { MediaPlayback } from './services/media-playback'

export function registerVlcIpc(
  player: VlcPlayer,
  settings: SettingsStore,
  htmlPlayback: MediaPlayback,
  getWindow: () => BrowserWindow | null,
  validate: (event: IpcMainInvokeEvent) => void,
) {
  const windowInfo = (): VlcWindow => {
    const window = getWindow()
    if (!window || window.isDestroyed()) throw new Error('应用窗口已关闭。')
    const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor
    const [width = 0, height = 0] = window.getContentSize()
    return {
      handle: window.getNativeWindowHandle().readBigUInt64LE().toString(),
      width: width * scale,
      height: height * scale,
      scale: scale * window.webContents.getZoomFactor(),
    }
  }
  const bind = <T>(channel: string, schema: z.ZodType<T>, action: (value: T) => unknown) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      validate(event)
      if (args.length > 1) throw new Error('VLC 播放参数无效。')
      const value = schema.safeParse(args[0])
      if (!value.success) throw new Error('VLC 播放参数无效。')
      return action(value.data)
    })
  }
  bind(channels.getVlcAvailability, z.undefined(), () => player.availability())
  bind(channels.openVlcPlayback, vlcOpenSchema, async (request) => {
    const saved = await settings.load()
    if (saved.warning) throw new Error(saved.warning)
    if (!saved.settings.player.useVlc) throw new Error('请先保存“使用 VLC 内嵌播放”配置。')
    htmlPlayback.close()
    return player.open(request, windowInfo(), saved.settings.player.startMuted)
  })
  bind(channels.controlVlcPlayback, vlcControlSchema, (request) =>
    player.control(request, windowInfo()),
  )
  bind(channels.getVlcPlayback, z.string().uuid(), (token) => player.state(token))
  bind(channels.closeVlcPlayback, z.string().uuid(), (token) => player.close(token))
}
