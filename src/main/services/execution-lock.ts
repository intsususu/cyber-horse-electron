/** 所有真实处理共用同一把锁，读取配置之前即占用，避免跨 IPC 竞争。 */
export class ExecutionLock {
  private owner = ''
  acquire(name: string): () => void {
    if (this.owner) throw new Error(`已有${this.owner}正在读取或执行，请等待完成或停止。`)
    this.owner = name
    return () => {
      this.owner = ''
    }
  }
}
