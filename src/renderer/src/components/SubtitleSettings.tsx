import type { Settings } from '../../../shared/contracts'
import { defaultSubtitleStyle } from '../../../shared/subtitle-style'
import { subtitlePreviewCues } from '../../../shared/subtitle-preview'
import { SubtitleVideoPreview } from './SubtitleVideoPreview'
import { Select } from './Select'
import '../styles/subtitle-settings.css'

type Subtitle = Settings['subtitle']
const numericFields = [
  ['fontSize', '字号', 16, 120, 1],
  ['outlineWidth', '描边宽度', 0, 8, 0.5],
  ['shadow', '阴影深度', 0, 8, 0.5],
  ['marginBottom', '底部边距', 0, 200, 1],
] as const

export function SubtitleSettings({
  value: storedValue,
  onChange,
  previewTarget,
  onPreviewOpenChange,
}: {
  value: Subtitle
  onChange: (value: Subtitle) => void
  previewTarget: HTMLElement | null
  onPreviewOpenChange: (open: boolean) => void
}) {
  const value = { ...defaultSubtitleStyle, ...storedValue }
  const update = (patch: Partial<Subtitle>) => onChange({ ...value, ...patch })
  const size = Number.isFinite(value.fontSize) ? Math.min(120, Math.max(16, value.fontSize)) : 56
  const outline = Math.max(0, Math.min(8, value.outlineWidth || 0)) * 0.6
  const shadows = outline
    ? Array.from({ length: 16 }, (_, index) => {
        const angle = (index * Math.PI) / 8
        return `${Math.cos(angle) * outline}px ${Math.sin(angle) * outline}px 0 ${value.outlineColor}`
      })
    : []
  if (value.shadow)
    shadows.push(`${value.shadow * 0.6}px ${value.shadow * 0.6}px 0 var(--subtitle-preview-shadow)`)
  return (
    <div className="subtitle-settings">
      <div className="subtitle-format-row">
        <h2>字幕格式</h2>
        <div className="segmented-options" role="group" aria-label="字幕格式">
          {(['srt', 'ass'] as const).map((format) => (
            <button
              key={format}
              className={value.format === format ? 'selected' : ''}
              aria-pressed={value.format === format}
              onClick={() => update({ format })}
            >
              {format.toUpperCase()}
            </button>
          ))}
        </div>
        <p className="preference-hint">
          {value.format === 'ass'
            ? '样式用于新生成并封装的 ASS 字幕。'
            : 'SRT 不保存字体样式；切换为 ASS 后，以下设置才会用于字幕输出。'}
        </p>
      </div>
      <div className="subtitle-style-heading">
        <h2>字幕字体</h2>
        <div className="subtitle-style-actions">
          <div className="subtitle-emphasis">
            <label className="preference-check">
              <input
                type="checkbox"
                checked={value.bold}
                onChange={(event) => update({ bold: event.target.checked })}
              />
              粗体
            </label>
            <label className="preference-check">
              <input
                type="checkbox"
                checked={value.italic}
                onChange={(event) => update({ italic: event.target.checked })}
              />
              斜体
            </label>
          </div>
          <button className="secondary-button" onClick={() => update(defaultSubtitleStyle)}>
            恢复默认样式
          </button>
        </div>
      </div>
      <div className="subtitle-style-fields">
        <div className="preference-field subtitle-font-field">
          <span>字体名称（可输入自定义字体）</span>
          <Select
            label="字体名称"
            listLabel="字幕字体"
            editable
            value={value.fontName}
            onChange={(fontName) => update({ fontName })}
            options={[
              { value: 'Microsoft YaHei', label: '微软雅黑' },
              { value: 'KaiTi', label: '楷体' },
              { value: 'SimHei', label: '黑体' },
              { value: 'SimSun', label: '宋体' },
              { value: 'Arial', label: 'Arial' },
            ]}
          />
        </div>
        {numericFields.map(([key, label, min, max, step]) => (
          <label className="preference-field" key={key}>
            {label}
            <input
              type="number"
              min={min}
              max={max}
              step={step}
              value={Number.isFinite(value[key]) ? value[key] : ''}
              onChange={(event) => update({ [key]: event.target.valueAsNumber })}
            />
          </label>
        ))}
        {(
          [
            ['color', '文字颜色'],
            ['outlineColor', '描边颜色'],
          ] as const
        ).map(([key, label]) => (
          <label className="preference-field" key={key}>
            {label}
            <span className="subtitle-color-input">
              <input
                type="color"
                value={value[key]}
                onChange={(event) => update({ [key]: event.target.value })}
              />
              <span aria-hidden="true">{value[key].toUpperCase()}</span>
            </span>
          </label>
        ))}
      </div>
      <section className="subtitle-preview-section" aria-label="字幕效果预览">
        <SubtitleVideoPreview
          style={value}
          target={previewTarget}
          onOpenChange={onPreviewOpenChange}
        >
          <span
            className="subtitle-preview-text"
            style={{
              fontFamily: `${JSON.stringify(value.fontName)}, var(--font-subtitle-fallback)`,
              fontSize: `${size * 0.6}px`,
              fontWeight: value.bold ? 700 : 400,
              fontStyle: value.italic ? 'italic' : 'normal',
              color: value.color,
              textShadow: shadows.join(', ') || 'none',
              paddingBottom: `${Math.max(0, Math.min(200, value.marginBottom || 0)) * 0.6}px`,
            }}
          >
            {subtitlePreviewCues[0]!.text[0]}
          </span>
        </SubtitleVideoPreview>
        <p className="preference-hint">
          内置四句示例字幕，点击上方预览 15 秒片段。尺寸按 1080p
          设置，字体需在本机安装；保存配置后用于后续任务。
        </p>
      </section>
    </div>
  )
}
