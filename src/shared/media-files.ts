// 新任务目录和旧版本遗留目录都不属于普通媒体扫描、提取或残留清理范围。
export const taskWorkDirectoryName = '.work'
export const legacyMediaDirectories = ['.cyber-horse-recovery', '.cyber-horse-work']
export const isInternalMediaEntry = (name: string): boolean =>
  name.toLowerCase() === taskWorkDirectoryName ||
  legacyMediaDirectories.includes(name.toLowerCase()) ||
  name.startsWith('.horse-') ||
  name.startsWith('.media-stage-') ||
  (name.startsWith('.cyber-horse-') && name.endsWith('.partial')) ||
  /^media-task-[0-9a-f-]{36}$/i.test(name) ||
  /\.[0-9a-f-]{36}\.download$/i.test(name)

/** 同时识别两种分隔符；直接选中内部目录的子文件也不能绕过扫描保护。 */
export const isInternalMediaPath = (path: string): boolean =>
  path.split(/[\\/]+/).some(isInternalMediaEntry)
