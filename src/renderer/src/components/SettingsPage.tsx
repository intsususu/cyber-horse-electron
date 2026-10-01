import { useEffect, useRef, useState } from 'react'
import { FileJson, FolderOpen, RotateCw, Save } from 'lucide-react'
import {
  pathKeys,
  toolKeys,
  type PathKey,
  type PreferencePathKey,
  type Settings,
  type HealthItem,
} from '../../../shared/contracts'
import { pathLabels } from '../data/catalog'
import type { Workspace } from '../hooks/use-workspace'
import { reconcileSettingsDraft } from '../lib/settings-draft'
import { settingsSaveError } from '../lib/settings-errors'
import { SubtitleSettings } from './SubtitleSettings'
import { subtitleStyleSchema } from '../../../shared/subtitle-style'

const tabs = [
  ['paths', '路径与工具'],
  ['subtitle', '字幕'],
  ['server', '媒体服务器'],
  ['privacy', '隐私封面'],
] as const
type Tab = (typeof tabs)[number][0]

export function SettingsPage({ workspace, target }: { workspace: Workspace; target?: PathKey }) {
  const [draft, setDraft] = useState<Settings>(structuredClone(workspace.settings))
  const baseline = useRef(workspace.settings)
  const [tab, setTab] = useState<Tab>('paths')
  const [configLocation, setConfigLocation] = useState('')
  const [password, setPassword] = useState('')
  const [hasPassword, setHasPassword] = useState(false)
  const [saving, setSaving] = useState(false)
  const [opening, setOpening] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [previewTarget, setPreviewTarget] = useState<HTMLDivElement | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  useEffect(() => {
    if (target) {
      const input = document.getElementById(`path-${target}`)
      input?.focus({ preventScroll: true })
      input?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    }
  }, [target])
  useEffect(() => {
    const previous = baseline.current
    baseline.current = workspace.settings
    setDraft((current) => reconcileSettingsDraft(current, previous, workspace.settings))
  }, [workspace.settings])
  useEffect(() => {
    if (window.cyberHorse) {
      void window.cyberHorse
        .getCredentialStatus()
        .then(setHasPassword)
        .catch(() => workspace.setToast('无法读取媒体服务器密码状态。'))
      void window.cyberHorse
        .getSettingsLocation()
        .then(setConfigLocation)
        .catch(() => workspace.setToast('无法读取配置文件位置。'))
    }
  }, [])

  async function choose(key: PathKey) {
    if (!window.cyberHorse) return workspace.setToast('路径选择请使用桌面应用。')
    try {
      const selected = await window.cyberHorse.choosePath(key)
      if (selected)
        setDraft((current) => ({ ...current, paths: { ...current.paths, [key]: selected } }))
    } catch {
      workspace.setToast('无法打开路径选择器，请重试。')
    }
  }
  async function chooseExtra(key: PreferencePathKey) {
    if (!window.cyberHorse) return workspace.setToast('路径选择请使用桌面应用。')
    try {
      const selected = await window.cyberHorse.choosePreferencePath(key)
      if (!selected) return
      if (key === 'mediaDownload')
        setDraft((current) => ({
          ...current,
          mediaServer: { ...current.mediaServer, downloadDirectory: selected },
        }))
      else
        setDraft((current) => ({
          ...current,
          privacyCover: {
            ...current.privacyCover,
            [key === 'posterCover' ? 'posterPath' : 'thumbPath']: selected,
          },
        }))
    } catch {
      workspace.setToast('无法打开路径选择器，请重试。')
    }
  }

  async function save() {
    if (!subtitleStyleSchema.strip().safeParse(draft.subtitle).success) {
      setSaveError(
        '请检查字幕样式：字体名称不能为空或包含逗号、引号；字号为 16–120，描边与阴影为 0–8，底部边距为 0–200。',
      )
      setTab('subtitle')
      return
    }
    const previous = baseline.current
    setSaving(true)
    setSaveError('')
    try {
      await workspace.updateSettings(
        (current) => reconcileSettingsDraft(draft, previous, current),
        true,
      )
      workspace.setToast('配置已保存。')
    } catch (error) {
      setSaveError(settingsSaveError(error))
    } finally {
      setSaving(false)
    }
  }

  async function openFile() {
    if (!window.cyberHorse) return
    setOpening(true)
    try {
      await window.cyberHorse.openSettingsFile()
      workspace.setToast('已打开配置文件，修改并保存后会自动同步配置项。')
    } catch {
      workspace.setToast('无法打开配置文件，请检查 JSON 默认打开程序和应用数据目录权限。')
    } finally {
      setOpening(false)
    }
  }
  async function savePassword(value: string) {
    if (!window.cyberHorse) return workspace.setToast('密码只能在桌面应用中安全保存。')
    setSaving(true)
    try {
      await window.cyberHorse.saveCredential(value)
      setHasPassword(Boolean(value))
      setPassword('')
      workspace.setToast(value ? '密码已安全保存。' : '密码已清除。')
    } catch {
      workspace.setToast('密码保存失败，请检查系统安全存储。')
    } finally {
      setSaving(false)
    }
  }

  function selectTab(next: Tab) {
    setTab(next)
    document.getElementById('settings-tab-' + next)?.focus()
  }

  return (
    <div
      ref={setPreviewTarget}
      className={`workspace-body settings-page ${previewOpen ? 'is-previewing' : ''}`}
    >
      <section className="panel settings-section preference-panel" inert={previewOpen}>
        <div className="preference-tabs" role="tablist" aria-label="配置分类">
          {tabs.map(([key, label], index) => (
            <button
              key={key}
              id={'settings-tab-' + key}
              role="tab"
              aria-selected={tab === key}
              aria-controls="settings-panel"
              tabIndex={tab === key ? 0 : -1}
              className={tab === key ? 'active' : ''}
              onClick={() => selectTab(key)}
              onKeyDown={(event) => {
                let next = index
                if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
                else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
                else if (event.key === 'Home') next = 0
                else if (event.key === 'End') next = tabs.length - 1
                else return
                event.preventDefault()
                selectTab(tabs[next]![0])
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          className={'preference-content' + (tab === 'paths' ? ' paths-content' : '')}
          id="settings-panel"
          role="tabpanel"
          aria-labelledby={'settings-tab-' + tab}
          tabIndex={0}
        >
          {tab === 'paths' && (
            <div className="settings-panels">
              <section className="settings-section directories-section">
                <div className="section-header">
                  <h2>工作目录</h2>
                </div>
                <div className="settings-fields">
                  {pathKeys
                    .filter((key) => !toolKeys.includes(key))
                    .map((key) => (
                      <PathField
                        key={key}
                        pathKey={key}
                        value={draft.paths[key]}
                        health={workspace.health.find((item) => item.key === key)}
                        checking={workspace.checking}
                        unsaved={draft.paths[key] !== workspace.settings.paths[key]}
                        onChange={(value) =>
                          setDraft((current) => ({
                            ...current,
                            paths: { ...current.paths, [key]: value },
                          }))
                        }
                        choose={choose}
                      />
                    ))}
                </div>
              </section>
              <section className="settings-section tools-section">
                <div className="section-header">
                  <h2>工具入口</h2>
                  <button
                    className="text-button"
                    disabled={workspace.checking || !workspace.loaded}
                    onClick={() => void workspace.checkHealth()}
                  >
                    <RotateCw size={15} className={workspace.checking ? 'spin' : ''} />
                    检查已保存路径
                  </button>
                </div>
                <div className="settings-fields">
                  {toolKeys.map((key) => (
                    <PathField
                      key={key}
                      pathKey={key}
                      value={draft.paths[key]}
                      health={workspace.health.find((item) => item.key === key)}
                      checking={workspace.checking}
                      unsaved={draft.paths[key] !== workspace.settings.paths[key]}
                      onChange={(value) =>
                        setDraft((current) => ({
                          ...current,
                          paths: { ...current.paths, [key]: value },
                        }))
                      }
                      choose={choose}
                    />
                  ))}
                </div>
              </section>
            </div>
          )}
          {tab === 'subtitle' && (
            <SubtitleSettings
              previewTarget={previewTarget}
              onPreviewOpenChange={setPreviewOpen}
              value={draft.subtitle}
              onChange={(subtitle) => setDraft((current) => ({ ...current, subtitle }))}
            />
          )}
          {tab === 'server' && (
            <>
              <label className="preference-field">
                服务器地址
                <input
                  value={draft.mediaServer.serverUrl}
                  placeholder="https://服务器地址"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      mediaServer: { ...current.mediaServer, serverUrl: event.target.value },
                    }))
                  }
                />
              </label>
              <label className="preference-field">
                用户名
                <input
                  value={draft.mediaServer.username}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      mediaServer: { ...current.mediaServer, username: event.target.value },
                    }))
                  }
                />
              </label>
              <ExtraPathField
                label="下载目录"
                value={draft.mediaServer.downloadDirectory}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    mediaServer: { ...current.mediaServer, downloadDirectory: value },
                  }))
                }
                choose={() => void chooseExtra('mediaDownload')}
              />
              <label className="preference-field">
                JavBus 地址（可选）
                <input
                  value={draft.mediaServer.javbusUrl}
                  placeholder="https://www.javbus.com/VDD-209"
                  aria-describedby="javbus-address-hint"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      mediaServer: { ...current.mediaServer, javbusUrl: event.target.value },
                    }))
                  }
                />
              </label>
              <p className="preference-hint" id="javbus-address-hint">
                可填写网站地址或示例详情链接，打开时自动替换为当前番号；留空隐藏图标。
              </p>
              <div className="preference-group">
                <h2>播放器</h2>
                <label className="preference-check">
                  <input
                    type="checkbox"
                    checked={draft.player.startMuted}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        player: { ...current.player, startMuted: event.target.checked },
                      }))
                    }
                  />
                  播放时默认静音
                </label>
                <p className="preference-hint">每次打开视频时生效，播放中仍可调整音量。</p>
              </div>
              <div className="preference-group">
                <h2>密码</h2>
                <p className="preference-hint">
                  {hasPassword ? '已在本机安全保存' : '尚未设置'} · 在媒体库页连接服务器
                </p>
                <div className="password-control">
                  <input
                    type="password"
                    aria-label="媒体服务器密码"
                    autoComplete="new-password"
                    value={password}
                    placeholder="输入新密码"
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <button
                    className="secondary-button"
                    disabled={saving || !password || !window.cyberHorse}
                    onClick={() => void savePassword(password)}
                  >
                    保存密码
                  </button>
                  {hasPassword && (
                    <button
                      className="text-button"
                      disabled={saving}
                      onClick={() => void savePassword('')}
                    >
                      清除
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
          {tab === 'privacy' && (
            <>
              <ExtraPathField
                label="海报封面图片"
                value={draft.privacyCover.posterPath}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    privacyCover: { ...current.privacyCover, posterPath: value },
                  }))
                }
                choose={() => void chooseExtra('posterCover')}
              />
              <ExtraPathField
                label="缩略图封面图片"
                value={draft.privacyCover.thumbPath}
                onChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    privacyCover: { ...current.privacyCover, thumbPath: value },
                  }))
                }
                choose={() => void chooseExtra('thumbCover')}
              />
              <label className="preference-check">
                <input
                  type="checkbox"
                  checked={draft.privacyCover.defaultEyeOpen}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      privacyCover: {
                        ...current.privacyCover,
                        defaultEyeOpen: event.target.checked,
                      },
                    }))
                  }
                />
                默认显示原始封面
              </label>
              <p className="preference-hint">
                媒体库中的眼睛按钮可临时切换全部封面；未配置替代图片时显示隐藏占位。
              </p>
            </>
          )}
        </div>
      </section>
      <div className="panel settings-save" inert={previewOpen}>
        <div className="save-context" title={configLocation || undefined}>
          {workspace.configWarning || saveError ? (
            <p className="config-error" role="alert">
              {saveError || workspace.configWarning}
            </p>
          ) : (
            <span>
              {window.cyberHorse ? '配置文件保存后自动同步' : '独立预览配置，未读取桌面配置文件'}
            </span>
          )}
        </div>
        <div className="settings-actions">
          <button
            className="secondary-button"
            disabled={opening || saving || !workspace.loaded || !window.cyberHorse}
            title={window.cyberHorse ? configLocation : '请在桌面应用中打开配置文件'}
            onClick={() => void openFile()}
          >
            <FileJson size={16} />
            {opening ? '正在打开…' : '打开配置文件'}
          </button>
          <button
            className="primary-button"
            disabled={saving || opening || !workspace.loaded}
            onClick={() => void save()}
          >
            <Save size={15} />
            {saving ? '正在保存…' : '保存配置'}
          </button>
        </div>
      </div>
    </div>
  )
}

function PathField({
  pathKey,
  value,
  onChange,
  choose,
  health,
  checking,
  unsaved,
}: {
  pathKey: PathKey
  value: string
  onChange: (value: string) => void
  choose: (key: PathKey) => Promise<void>
  health?: HealthItem
  checking: boolean
  unsaved: boolean
}) {
  const message = unsaved
    ? '未保存，保存后自动检测'
    : checking
      ? '正在检测…'
      : (health?.message ?? '尚未完成检测')
  const issue = !unsaved && !checking && health && health.status !== 'ready'
  return (
    <label className="path-field" htmlFor={`path-${pathKey}`}>
      <span>{pathLabels[pathKey]}</span>
      <div>
        <input
          id={`path-${pathKey}`}
          aria-label={pathLabels[pathKey]}
          aria-describedby={`path-health-${pathKey}`}
          value={value}
          maxLength={4096}
          placeholder={
            pathKey === 'whisper'
              ? '选择含 .venv 的 Whisper 源码目录'
              : toolKeys.includes(pathKey)
                ? '选择工具入口文件'
                : '选择或输入绝对路径'
          }
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          className="icon-button"
          type="button"
          aria-label={`选择${pathLabels[pathKey]}`}
          onClick={() => void choose(pathKey)}
        >
          <FolderOpen size={17} />
        </button>
      </div>
      <small
        id={`path-health-${pathKey}`}
        className={`path-health ${issue ? 'health-warning' : ''}`}
      >
        {message}
      </small>
    </label>
  )
}

function ExtraPathField({
  label,
  value,
  onChange,
  choose,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  choose: () => void
}) {
  return (
    <label className="preference-field">
      {label}
      <span className="preference-path">
        <input
          value={value}
          maxLength={4096}
          placeholder="选择或输入绝对路径"
          onChange={(event) => onChange(event.target.value)}
        />
        <button className="icon-button" type="button" aria-label={`选择${label}`} onClick={choose}>
          <FolderOpen size={17} />
        </button>
      </span>
    </label>
  )
}
