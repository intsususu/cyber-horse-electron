/** 仅在隔离桌面测试收尾时明确确认退出；其他原生弹窗仍走原逻辑。 */
export async function closeDesktop(app) {
  if (!app) return
  await app.evaluate(({ dialog }) => {
    const original = dialog.showMessageBox
    dialog.showMessageBox = (...args) => {
      const options = args.at(-1)
      if (options?.title === '退出程序')
        return Promise.resolve({ response: 1, checkboxChecked: false })
      return original(...args)
    }
  })
  await app.close()
}
