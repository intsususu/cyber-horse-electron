export function settingsSaveError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('unrecognized_keys') && /fontName|fontSize|outlineColor/.test(message))
    return '桌面后台尚未更新，暂不支持字幕字体配置。请在任务结束后完整退出并重新打开应用，再保存；当前填写内容已保留。'
  if (message.includes('unrecognized_keys') && message.includes('javbusUrl'))
    return '桌面后台尚未更新，暂不支持 JavBus 地址。请在任务结束后完整退出并重新打开应用，再保存；当前填写内容已保留。'
  if (message.includes('javbusUrl') && message.includes('custom'))
    return 'JavBus 地址格式无效，请填写 HTTP 或 HTTPS 网站地址，且不要包含账号密码、查询参数或片段。'
  return '配置保存失败，请检查各分组的地址、路径和应用数据目录权限。'
}
