import { ScanSearch, HardDrive, Captions, Clapperboard } from 'lucide-react'
import type { PathKey } from '../../../shared/contracts'

export const workbenchSteps = [
  {
    id: 'subtitle-mux',
    title: '字幕与封装',
    directoryKey: 'whisperOutput',
    tool: 'Whisper + MKVToolNix',
    icon: Captions,
  },
  {
    id: 'video',
    title: '视频破解',
    directoryKey: 'videoOutput',
    tool: 'Jasna',
    icon: Clapperboard,
  },
  {
    id: 'scrape',
    title: '元数据刮削',
    directoryKey: 'mdcOutput',
    tool: 'Movie_Data_Capture',
    icon: ScanSearch,
  },
  { id: 'archive', title: '归档到 NAS', directoryKey: 'nas', tool: '文件归档', icon: HardDrive },
] as const
export const pathLabels: Record<PathKey, string> = {
  download: '下载目录',
  preprocess: '预处理目录',
  mdcOutput: 'MDC 输出目录',
  nas: 'NAS 媒体目录',
  whisperOutput: '字幕工作目录',
  videoOutput: '视频输出目录',
  mdc: 'Movie_Data_Capture',
  whisper: 'Faster-Whisper 源码目录',
  mkvmerge: 'MKVToolNix',
  jasna: 'Jasna',
}
export type Page = 'overview' | 'queue' | 'library' | 'popular' | 'settings'
export const pageNames: Record<Page, string> = {
  overview: '工作台',
  queue: '任务队列',
  library: 'EMBY媒体库',
  popular: '热门推荐',
  settings: '偏好配置',
}
