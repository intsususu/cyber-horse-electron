import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  safeStorage,
  shell,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { appendFile, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  inputRequestSchema,
  refreshInputRequestSchema,
  pathKeys,
  preferencePathKeys,
  settingsSchema,
  toolKeys,
  openDirectoryKeys,
  type OpenDirectoryKey,
} from '../shared/contracts'
import { channels } from '../shared/channels'
import { SettingsStore } from './services/settings-store'
import { CredentialStore } from './services/credential-store'
import { initializeProjectDefaults } from './services/project-defaults'
import { checkPaths } from './services/path-health'
import { collectMediaInputs, mediaExtensions } from './services/media-inputs'
import { PerformanceMonitor } from './services/performance'
import { PreparationService } from './services/preparation'
import { preparationRequestSchema } from '../shared/preparation'
import { PipelineService } from './services/pipeline'
import { ExecutionLock } from './services/execution-lock'
import { pipelinePreviewSchema, pipelineStartSchema } from '../shared/pipeline'
import { largeFileBytes } from './services/preparation'
import { EmbyClient } from './services/emby-client'
import { MediaDownloads } from './services/media-downloads'
import { registerMediaIpc } from './media-ipc'
import { MediaPopularService } from './services/media-popular'
import { MediaProcessService } from './services/media-process'
import { MediaPlayback } from './services/media-playback'
import { MediaPlaybackLog } from './services/media-playback-log'
import { ExecutionRecords } from './services/execution-records'
import { executionRecordSchema } from '../shared/execution-record'
import {
  taskConfirmationSchema,
  taskIdRequestSchema,
  taskPreviewRequestSchema,
} from '../shared/task-workspace'
import { WorkspaceTasks, taskServer } from './services/workspace-tasks'
import { basename } from 'node:path'
import { fileStamp, checkDirectory } from './services/safe-files'
import { SubtitlePreviewService } from './services/subtitle-preview'
import { ShutdownService, windowsShutdownAdapter } from './services/shutdown'
import { ExitGuard } from './services/exit-guard'
import { shutdownRequestSchema } from '../shared/shutdown'
import {
  subtitlePreviewRequestSchema,
  subtitlePreviewCancelSchema,
} from '../shared/subtitle-preview'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'horse',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
])
if (process.env.CYBER_HORSE_DATA_DIR && !app.isPackaged)
  app.setPath('userData', process.env.CYBER_HORSE_DATA_DIR)
// 同一应用数据目录只允许一个后台，避免重复执行或同时接管中断任务。
const primaryInstance = app.requestSingleInstanceLock()
// 此时尚未创建服务；立即退出，避免正常退出期间继续初始化被主实例占用的缓存。
if (!primaryInstance) app.exit(0)
let mainWindow: BrowserWindow | null = null
let markWindowReady: (() => void) | undefined
let firstWindowShown = false
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed() || !firstWindowShown) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})
let settingsStore: SettingsStore
let stopWatchingSettings: (() => void) | undefined
const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const performanceMonitor = new PerformanceMonitor()
let choosingInputs = false
let selectedInputDirectory: string | null = null
let preparation: PreparationService
let pipeline: PipelineService
let mediaClient: EmbyClient
let mediaPopular: MediaPopularService
let mediaDownloads: MediaDownloads
let mediaProcesses: MediaProcessService
let mediaPlayback: MediaPlayback
let workspaceTasks: WorkspaceTasks
let subtitlePreview: SubtitlePreviewService
let shutdown: ShutdownService
let pipelineSource: 'preprocess' | 'current' = 'preprocess'
const exitGuard = new ExitGuard(
  async (busy) => {
    if (!mainWindow || mainWindow.isDestroyed()) return true
    const result = await dialog.showMessageBox(mainWindow, {
      type: busy ? 'warning' : 'question',
      title: '退出程序',
      message: busy ? '仍有任务正在运行或等待执行，确定退出？' : '确定退出程序？',
      detail:
        '退出会停止正在运行和等待执行的任务，并等待文件操作收尾；未完成文件将保留，重新打开后需手动确认恢复。关机计划会取消。',
      buttons: ['继续使用', busy ? '停止任务并退出' : '退出程序'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    return result.response === 1
  },
  () =>
    preparation.active ||
    pipeline.active ||
    mediaDownloads.running ||
    mediaProcesses.active ||
    mediaProcesses.queueSummary().active > 0 ||
    workspaceTasks.active ||
    subtitlePreview.active,
  async () => {
    shutdown.stop()
    preparation.cancel()
    pipeline.cancel()
    mediaClient.invalidate()
    const results = await Promise.allSettled([
      preparation.wait(),
      pipeline.wait(),
      mediaDownloads.stop(),
      mediaProcesses.stop(),
      workspaceTasks.stop(),
      subtitlePreview.stop(),
    ])
    if (results.some((result) => result.status === 'rejected')) throw new Error('任务收尾失败。')
  },
  () => mainWindow?.close(),
  () =>
    dialog.showErrorBox(
      '暂未退出',
      '任务收尾未能完成，已保留窗口。请检查任务与文件后再次尝试退出。',
    ),
  () => {
    shutdown.stop()
    preparation.cancel()
    pipeline.cancel()
    // 字幕预览的调用持续到生成结束，先取消才能等待已受理请求落定。
    void subtitlePreview.stop().catch(() => {})
  },
)
const runTask = <T>(action: () => T | Promise<T>) =>
  exitGuard.runTask(() => shutdown.runTask(action))

function validateSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame
  const url = frame ? new URL(frame.url) : null
  const expectedOrigin = devUrl ? new URL(devUrl).origin : 'horse://app'
  const actualOrigin = url?.protocol === 'horse:' ? `${url.protocol}//${url.host}` : url?.origin
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    frame !== event.sender.mainFrame ||
    actualOrigin !== expectedOrigin
  ) {
    throw new Error('不允许此页面访问桌面能力')
  }
}

function allowPlayerFullscreen(
  contents: WebContents | null,
  permission: string,
  details: { isMainFrame: boolean; requestingUrl?: string },
): boolean {
  if (
    !mainWindow ||
    contents !== mainWindow.webContents ||
    permission !== 'fullscreen' ||
    !details.isMainFrame
  )
    return false
  const expected = devUrl || 'horse://app/index.html'
  return (
    details.requestingUrl === contents.mainFrame.url &&
    new URL(contents.mainFrame.url).href === new URL(expected).href
  )
}

function createWindow(): void {
  firstWindowShown = false
  mainWindow = new BrowserWindow({
    title: 'Cyber Horse',
    icon: join(app.getAppPath(), 'assets/icon.png'),
    width: 1480,
    height: 900,
    minWidth: 1060,
    minHeight: 760,
    show: false,
    frame: false,
    backgroundColor: '#101214',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  // 首帧可绘制不代表配置已恢复；两者都完成后只显示一次，避免闪过默认主题。
  const window = mainWindow
  let painted = false
  let configured = false
  let shown = false
  const showWhenReady = () => {
    if (!painted || !configured || shown || window.isDestroyed()) return
    shown = true
    firstWindowShown = true
    window.show()
  }
  markWindowReady = () => {
    configured = true
    showWhenReady()
  }
  window.once('ready-to-show', () => {
    painted = true
    showWhenReady()
  })
  mainWindow.on('close', (event) => {
    if (exitGuard.approved) return
    event.preventDefault()
    void exitGuard.request()
  })
  stopWatchingSettings = settingsStore.watch((result) => {
    mediaClient.syncSettings(result.settings)
    if (mainWindow && !mainWindow.webContents.isDestroyed())
      mainWindow.webContents.send(channels.settingsChanged, result)
  })
  mainWindow.on('closed', () => {
    stopWatchingSettings?.()
    stopWatchingSettings = undefined
    performanceMonitor.stop()
    mediaPlayback.close()
    mediaClient.invalidate()
    selectedInputDirectory = null
    mainWindow = null
    markWindowReady = undefined
  })
  if (devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadURL('horse://app/index.html')
}

void app.whenReady().then(async () => {
  if (!primaryInstance) return
  const store = new SettingsStore(app.getPath('userData'))
  settingsStore = store
  subtitlePreview = new SubtitlePreviewService(
    app.getPath('userData'),
    async () => (await store.load()).settings,
  )
  ipcMain.handle(channels.generateSubtitlePreview, (event, ...args: unknown[]) => {
    validateSender(event)
    const parsed = subtitlePreviewRequestSchema.safeParse(args[0])
    if (args.length !== 1 || !parsed.success) throw new Error('字幕预览参数无效。')
    return exitGuard.runTask(() => subtitlePreview.generate(parsed.data))
  })
  ipcMain.handle(channels.cancelSubtitlePreview, (event, ...args: unknown[]) => {
    validateSender(event)
    const parsed = subtitlePreviewCancelSchema.safeParse(args[0])
    if (args.length !== 1 || !parsed.success) throw new Error('字幕预览标识无效。')
    return subtitlePreview.cancel(parsed.data.id)
  })
  const executionRecords = new ExecutionRecords(app.getPath('userData'), (path) =>
    shell.openPath(path),
  )
  ipcMain.handle(channels.openExecutionRecord, async (event, ...args: unknown[]) => {
    validateSender(event)
    const parsed = executionRecordSchema.safeParse(args[0])
    if (args.length !== 1 || !parsed.success) throw new Error('执行记录标识无效。')
    await executionRecords.open(parsed.data)
  })
  const executionLock = new ExecutionLock()
  const protectedPaths = [app.getAppPath(), resolve(app.getAppPath(), '../cyber-horse')]
  const credentials = new CredentialStore(app.getPath('userData'), safeStorage)
  let defaultsWarning = ''
  // 隔离测试配置不读取本机项目默认值；正常开发和安装版读取项目内默认文件。
  if (app.isPackaged || !process.env.CYBER_HORSE_DATA_DIR) {
    try {
      await initializeProjectDefaults(
        join(app.getAppPath(), 'config/default-settings.json'),
        store,
        credentials,
      )
    } catch {
      defaultsWarning =
        '项目默认配置初始化失败，请检查 config/default-settings.json 或系统安全存储。'
    }
  }
  const rendererRoot = resolve(__dirname, '../renderer')
  protocol.handle('horse', (request) => {
    const url = new URL(request.url)
    if (url.host !== 'app') return new Response('禁止访问', { status: 403 })
    // 开发页面与媒体协议不同源；仅向当前可信开发来源开放媒体响应。
    const playbackResponse = (response: Response) => {
      if (devUrl && request.headers.get('origin') === new URL(devUrl).origin) {
        response.headers.set('Access-Control-Allow-Origin', new URL(devUrl).origin)
        response.headers.set('Vary', 'Origin')
      }
      return response
    }
    const playbackToken = /^\/media-playback\/([0-9a-f-]{36})\/stream\.(?:mp4|m4v|webm|mkv)$/.exec(
      url.pathname,
    )
    if (playbackToken && !url.search)
      return mediaPlayback.response(request, playbackToken[1]!).then(playbackResponse)
    const subtitleToken = /^\/media-playback\/([0-9a-f-]{36})\/subtitles\/(\d{1,4})\.vtt$/.exec(
      url.pathname,
    )
    if (
      subtitleToken &&
      (!url.search || /^\?attempt=\d{1,9}$/.test(url.search)) &&
      request.method === 'GET'
    )
      return mediaPlayback
        .subtitle(subtitleToken[1]!, Number(subtitleToken[2]))
        .then(playbackResponse)
    let file: string
    try {
      file = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`)
    } catch {
      return new Response('无效路径', { status: 400 })
    }
    if (!file.startsWith(rendererRoot + sep)) return new Response('禁止访问', { status: 403 })
    return net.fetch(pathToFileURL(file).href)
  })
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(allowPlayerFullscreen(contents, permission, details)),
  )
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    allowPlayerFullscreen(contents, permission, details),
  )
  const validSettings = async () => {
    const result = await store.load()
    if (result.warning) throw new Error('配置文件无效，请修复后重新预览。')
    return result.settings
  }
  mediaClient = new EmbyClient(validSettings, () => credentials.readPassword())
  mediaPopular = new MediaPopularService(app.getPath('userData'), mediaClient)
  mediaPopular.start()
  workspaceTasks = new WorkspaceTasks(
    app.getPath('userData'),
    protectedPaths,
    validSettings,
    undefined,
    async (task, signal) => {
      const sync = task.context?.sync
      if (!sync || sync.server !== taskServer(await validSettings()))
        throw new Error('服务器身份已变化，未向新服务器同步历史任务。')
      if (sync.serverIdentity && sync.serverIdentity !== (await mediaClient.serverIdentity()))
        throw new Error('Emby 实际服务器身份已变化，未同步历史任务。')
      const video = task.files[0]?.publications.find((value) =>
        /\.(mp4|mkv|avi|mov|wmv|flv|m4v|ts|mts|m2ts|webm|mpg|mpeg|vob)$/i.test(value.target),
      )
      if (!video) throw new Error('任务缺少已发布媒体，未提交刷新。')
      const remote = sync.originalRemotePath.replace(/[^\\/]+$/, basename(video.target))
      return mediaClient.synchronizePublished(
        {
          itemId: sync.itemId,
          path: remote,
          size: (await fileStamp(video.target)).size,
          chinese: task.files[0]!.marks.chinese.present,
        },
        signal,
        sync.userData,
      )
    },
  )
  pipeline = new PipelineService(
    app.getPath('userData'),
    protectedPaths,
    undefined,
    executionLock,
    true,
    workspaceTasks,
  )
  preparation = new PreparationService(
    app.getPath('userData'),
    protectedPaths,
    largeFileBytes,
    executionLock,
    workspaceTasks.scheduler,
  )
  const taskBind = <T>(
    channel: string,
    schema: { parse(value: unknown): T },
    action: (value: T) => unknown,
  ) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      validateSender(event)
      if (args.length !== 1) throw new Error('任务请求参数数量无效。')
      return action(schema.parse(args[0]))
    })
  }
  ipcMain.handle(channels.listWorkspaceTasks, (event, ...args: unknown[]) => {
    validateSender(event)
    if (args.length) throw new Error('任务列表不接受额外参数。')
    return workspaceTasks.list()
  })
  taskBind(channels.cancelWorkspaceTask, taskIdRequestSchema, ({ id }: { id: string }) =>
    workspaceTasks.cancel(id),
  )
  taskBind(
    channels.previewWorkspaceAction,
    taskPreviewRequestSchema,
    ({ id, action }: ReturnType<typeof taskPreviewRequestSchema.parse>) =>
      workspaceTasks.previewAction(id, action),
  )
  taskBind(
    channels.confirmWorkspaceAction,
    taskConfirmationSchema,
    ({ planId, revision }: { planId: string; revision: number }) =>
      runTask(() => workspaceTasks.confirmAction(planId, revision)),
  )
  taskBind(channels.openWorkspaceDirectory, taskIdRequestSchema, async ({ id }: { id: string }) => {
    await workspaceTasks.list()
    const path = await checkDirectory(workspaceTasks.directory(id))
    if (await shell.openPath(path)) throw new Error('无法打开任务目录。')
  })
  mediaPlayback = new MediaPlayback(mediaClient, new MediaPlaybackLog(app.getPath('userData')))
  mediaDownloads = new MediaDownloads(
    app.getPath('userData'),
    [...protectedPaths, app.getPath('userData')],
    mediaClient,
    validSettings,
  )
  mediaProcesses = new MediaProcessService(
    app.getPath('userData'),
    [...protectedPaths, app.getPath('userData')],
    mediaClient,
    mediaDownloads,
    validSettings,
    executionLock,
    undefined,
    workspaceTasks,
  )
  // 隔离桌面测试强制使用替身；打包后环境变量不能替换真实系统适配器。
  const shutdownAdapter =
    !app.isPackaged && process.env.CYBER_HORSE_DATA_DIR
      ? {
          supported: true,
          testMode: true,
          execute: async () => {
            await appendFile(
              join(app.getPath('userData'), 'shutdown-test.jsonl'),
              JSON.stringify({ event: '关机请求', at: new Date().toISOString() }) + '\n',
              'utf8',
            )
          },
        }
      : windowsShutdownAdapter()
  shutdown = new ShutdownService(() => {
    const mediaQueued = mediaProcesses.queueSummary().active > 0
    const preparationState = preparation.snapshot()
    const preparationRunning = ['running', 'cancelling'].includes(preparationState?.status ?? '')
    return {
      busy:
        preparation.active ||
        pipeline.active ||
        mediaDownloads.running ||
        mediaProcesses.active ||
        mediaQueued ||
        workspaceTasks.active ||
        subtitlePreview.active,
      hasTasks:
        preparationRunning || mediaDownloads.running || mediaQueued || workspaceTasks.active,
      awaitingConfirmation: workspaceTasks.awaitingConfirmation,
      failedTaskIds: [
        ...(preparationState?.status === 'failed' ? [preparationState.id] : []),
        ...workspaceTasks.failedTaskIds,
        ...mediaProcesses.failedTaskIds,
        ...mediaDownloads.failedTaskIds,
      ],
    }
  }, shutdownAdapter)
  ipcMain.handle(channels.getShutdownState, (event, ...args: unknown[]) => {
    validateSender(event)
    if (args.length) throw new Error('关机状态不接受额外参数。')
    return shutdown.snapshot()
  })
  ipcMain.handle(channels.startShutdown, async (event, ...args: unknown[]) => {
    validateSender(event)
    const parsed = shutdownRequestSchema.safeParse(args[0])
    if (args.length !== 1 || !parsed.success) throw new Error('关机计划参数无效。')
    await workspaceTasks.list()
    await mediaDownloads.snapshot()
    validateSender(event)
    return exitGuard.runTask(() => shutdown.start(parsed.data))
  })
  ipcMain.handle(channels.cancelShutdown, (event, ...args: unknown[]) => {
    validateSender(event)
    if (args.length) throw new Error('取消关机不接受额外参数。')
    return shutdown.cancel()
  })
  registerMediaIpc(
    mediaClient,
    mediaDownloads,
    mediaProcesses,
    mediaPlayback,
    validateSender,
    workspaceTasks,
    mediaPopular,
    runTask,
  )
  ipcMain.handle(channels.previewPipeline, async (event, value: unknown) => {
    validateSender(event)
    const parsed = pipelinePreviewSchema.safeParse(value)
    if (!parsed.success) throw new Error('处理步骤或文件范围参数无效。')
    const settings = await validSettings()
    const request = parsed.data
    const source = request.source === 'current' ? selectedInputDirectory : settings.paths.preprocess
    if (!source) throw new Error('请先配置或选择工作目录。')
    const plan = await pipeline.preview(settings, request, source)
    pipelineSource = request.source
    return plan
  })
  ipcMain.handle(channels.startPipeline, async (event, value: unknown) => {
    validateSender(event)
    const parsed = pipelineStartSchema.safeParse(value)
    if (!parsed.success) throw new Error('处理清单标识无效，请重新预览。')
    const settings = await validSettings()
    return runTask(() =>
      pipeline.start(
        parsed.data.planId,
        settings,
        pipelineSource === 'current' ? (selectedInputDirectory ?? '') : settings.paths.preprocess,
      ),
    )
  })
  ipcMain.handle(channels.getPipelineState, (event) => {
    validateSender(event)
    return pipeline.snapshot()
  })
  ipcMain.handle(channels.cancelPipeline, (event) => {
    validateSender(event)
    pipeline.cancel()
  })
  const preparationPaths = async () => {
    const result = await store.load()
    if (result.warning) throw new Error('配置文件无效，请修复并保存后重新预览。')
    return {
      download: result.settings.paths.download,
      preprocess: result.settings.paths.preprocess,
    }
  }
  ipcMain.handle(channels.previewPreparation, async (event, ...args: unknown[]) => {
    validateSender(event)
    if (args.length) throw new Error('预处理预览不接受路径参数。')
    return preparation.preview(await preparationPaths())
  })
  ipcMain.handle(channels.startPreparation, async (event, value: unknown) => {
    validateSender(event)
    const request = preparationRequestSchema.safeParse(value)
    if (!request.success) throw new Error('预处理计划参数无效，请重新预览。')
    const paths = await preparationPaths()
    return runTask(() => preparation.start(request.data.planId, paths))
  })
  ipcMain.handle(channels.getPreparationState, (event) => {
    validateSender(event)
    return preparation.snapshot()
  })
  ipcMain.handle(channels.cancelPreparation, (event) => {
    validateSender(event)
    preparation.cancel()
  })
  ipcMain.handle(channels.getSettings, async (event) => {
    validateSender(event)
    const result = await store.load()
    return defaultsWarning ? { ...result, warning: result.warning ?? defaultsWarning } : result
  })
  ipcMain.handle(channels.getSettingsLocation, (event) => {
    validateSender(event)
    return store.filePath
  })
  ipcMain.handle(channels.openSettingsFile, async (event) => {
    validateSender(event)
    await store.ensureFile()
    const error = await shell.openPath(store.filePath)
    if (error) throw new Error('无法打开配置文件，请检查 JSON 文件的默认打开程序。')
  })
  ipcMain.handle(channels.saveSettings, async (event, value: unknown) => {
    validateSender(event)
    await store.save(settingsSchema.parse(value))
  })
  ipcMain.handle(channels.choosePath, async (event, value: unknown) => {
    validateSender(event)
    if (typeof value !== 'string' || !pathKeys.includes(value as (typeof pathKeys)[number]))
      throw new Error('无效路径类型')
    const key = value as (typeof pathKeys)[number]
    const sourceDirectory = key === 'whisper'
    const toolFile = toolKeys.includes(key) && !sourceDirectory
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: sourceDirectory
        ? '选择 Whisper 源码目录'
        : toolFile
          ? '选择工具入口文件'
          : '选择工作目录',
      properties: [toolFile ? 'openFile' : 'openDirectory'],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(channels.choosePreferencePath, async (event, value: unknown) => {
    validateSender(event)
    if (
      typeof value !== 'string' ||
      !preferencePathKeys.includes(value as (typeof preferencePathKeys)[number])
    )
      throw new Error('无效路径类型')
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: value === 'mediaDownload' ? '选择媒体服务器下载目录' : '选择隐私封面图片',
      properties: [value === 'mediaDownload' ? 'openDirectory' : 'openFile'],
      ...(value === 'mediaDownload'
        ? {}
        : { filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] }),
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(channels.getCredentialStatus, (event) => {
    validateSender(event)
    return credentials.hasPassword()
  })
  ipcMain.handle(channels.saveCredential, async (event, value: unknown) => {
    validateSender(event)
    if (typeof value !== 'string') throw new Error('密码格式无效')
    await credentials.savePassword(value)
    mediaClient.invalidate()
  })
  ipcMain.handle(channels.checkPaths, async (event) => {
    validateSender(event)
    return checkPaths((await store.load()).settings)
  })
  ipcMain.handle(channels.chooseInputs, async (event, value: unknown) => {
    validateSender(event)
    const request = inputRequestSchema.parse(value)
    if (choosingInputs) throw new Error('文件选择正在进行，请稍候')
    choosingInputs = true
    try {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: request.mode === 'directory' ? '选择视频所在目录' : '选择一个或多个视频文件',
        defaultPath:
          selectedInputDirectory || (await store.load()).settings.paths.preprocess || undefined,
        properties:
          request.mode === 'directory' ? ['openDirectory'] : ['openFile', 'multiSelections'],
        ...(request.mode === 'files'
          ? { filters: [{ name: '视频文件', extensions: mediaExtensions }] }
          : {}),
      })
      if (result.canceled || !result.filePaths.length) return null
      const selection = await collectMediaInputs(
        result.filePaths,
        request.recursive,
        request.mode === 'directory',
      )
      selectedInputDirectory = selection.directory
      return selection
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error)
        throw new Error('无法读取所选文件或目录，请检查访问权限')
      throw error
    } finally {
      choosingInputs = false
    }
  })
  ipcMain.handle(channels.getPerformance, (event) => {
    validateSender(event)
    return performanceMonitor.snapshot()
  })
  ipcMain.handle(channels.refreshInputs, async (event, value: unknown) => {
    validateSender(event)
    const request = refreshInputRequestSchema.parse(value)
    if (choosingInputs) throw new Error('文件读取正在进行，请稍候')
    choosingInputs = true
    try {
      const directory =
        request.source === 'current'
          ? selectedInputDirectory
          : (await store.load()).settings.paths[request.source]
      if (!directory)
        throw new Error(
          request.source === 'current' ? '请先选择工作目录' : '请先保存所需的目录配置',
        )
      return await collectMediaInputs([directory], request.recursive, true)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error)
        throw new Error('无法读取工作目录，请检查路径或访问权限')
      throw error
    } finally {
      choosingInputs = false
    }
  })
  ipcMain.handle(channels.openWorkDirectory, async (event, key: unknown, ...args: unknown[]) => {
    validateSender(event)
    if (
      args.length ||
      typeof key !== 'string' ||
      !openDirectoryKeys.includes(key as OpenDirectoryKey)
    )
      throw new Error('工作目录类型无效。')
    let directory: string | null
    if (key === 'current') {
      directory = selectedInputDirectory
    } else {
      const result = await store.load()
      if (result.warning) throw new Error('配置文件无效，请修复后重试。')
      directory = result.settings.paths[key as Exclude<OpenDirectoryKey, 'current'>]
    }
    if (!directory) throw new Error('请先在偏好配置中设置对应的工作目录。')
    if (!isAbsolute(directory)) throw new Error('工作目录路径无效，请检查配置。')
    let directoryStat
    try {
      directoryStat = await stat(directory)
    } catch {
      throw new Error('工作目录无法访问，请检查路径或权限。')
    }
    if (!directoryStat.isDirectory()) throw new Error('工作目录不是文件夹。')
    const error = await shell.openPath(directory)
    if (error) throw new Error('无法打开工作目录，请检查系统文件管理器。')
  })
  ipcMain.handle(channels.windowReady, (event, ...args: unknown[]) => {
    validateSender(event)
    if (args.length) throw new Error('窗口就绪通知不接受参数')
    markWindowReady?.()
  })
  ipcMain.handle(channels.windowControl, (event, action: unknown) => {
    validateSender(event)
    if (action === 'minimize') mainWindow?.minimize()
    else if (action === 'maximize') {
      if (mainWindow?.isMaximized()) mainWindow.unmaximize()
      else mainWindow?.maximize()
    } else if (action === 'close') mainWindow?.close()
    else throw new Error('无效窗口操作')
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', (event) => {
  if (mainWindow && !exitGuard.approved) {
    event.preventDefault()
    void exitGuard.request()
    return
  }
  shutdown?.stop()
  performanceMonitor.stop()
  mediaPopular?.stop()
})
