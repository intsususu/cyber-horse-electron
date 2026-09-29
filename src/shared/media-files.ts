// 仅用于排除旧版本遗留目录，新任务不再创建这些目录。
export const legacyMediaDirectories = ['.cyber-horse-recovery', '.cyber-horse-work']
export const isInternalMediaEntry = (name: string): boolean =>
  legacyMediaDirectories.includes(name.toLowerCase()) ||
  name.startsWith('.horse-') ||
  name.startsWith('.media-stage-') ||
  (name.startsWith('.cyber-horse-') && name.endsWith('.partial')) ||
  /^media-task-[0-9a-f-]{36}$/i.test(name)
