import type { WritebackStatus } from './queue.js'

/** One cancellable request stream per visible turn; stale GETs cannot undo retries. */
export class WritebackStatusClient {
  private request: AbortController | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private visible = true
  private retrying = false
  private failures = 0
  private value: WritebackStatus | undefined
  private readError: string | undefined
  // Browser fetch checks its Window receiver. Never store it as an unbound
  // instance method: this.fetcher() would supply the client as its receiver.
  constructor(private readonly url: string, private readonly change: (value: WritebackStatus | undefined, retrying: boolean, readError?: string) => void, private readonly fetcher: typeof fetch = (...args) => globalThis.fetch(...args)) {}

  setVisible(visible: boolean): void {
    this.visible = visible
    if (visible) this.refresh()
    else { clearTimeout(this.timer); if (!this.retrying) this.request?.abort() }
  }

  refresh(): void {
    if (this.disposed || !this.visible || this.retrying || this.request && !this.request.signal.aborted) return
    void this.load(false)
  }

  retry(): void {
    if (this.disposed || this.retrying || !this.value?.retryable) return
    this.retrying = true
    this.request?.abort()
    this.change(this.value, true)
    void this.load(true)
  }

  private async load(retry: boolean): Promise<void> {
    clearTimeout(this.timer)
    const controller = new AbortController()
    this.request = controller
    const timeout = setTimeout(() => controller.abort(new Error('状态请求超时')), 15_000)
    let delay = 15_000
    try {
      const response = await this.fetcher(this.url, {
        method: retry ? 'POST' : 'GET', signal: controller.signal,
        headers: { accept: 'application/json', 'x-dsh-knowledge-client': 'conversation-web' },
      })
      const body = await response.json() as WritebackStatus
      if (this.request !== controller || this.disposed) return
      if (!response.ok && (retry || response.status !== 404)) throw new Error(body.error ?? `状态请求失败（HTTP ${response.status}）`)
      this.readError = undefined
      if (response.ok && body.summary) {
        this.value = body
        this.failures = 0
        delay = body.status === 'completed' ? 0 : body.status === 'failed' ? 15_000 : 1_500
      } else {
        delay = ++this.failures <= 3 ? 1_500 : 60_000
      }
    } catch (error) {
      if (this.request !== controller || this.disposed) return
      delay = Math.min(60_000, 2_000 * 2 ** Math.min(5, this.failures++))
      if (retry && this.value) this.value = { ...this.value, error: error instanceof Error ? error.message : String(error) }
      else if (this.visible) this.readError = '暂时无法读取回写状态，正在自动重试；这不代表回写失败。'
    } finally {
      clearTimeout(timeout)
      if (this.request === controller && !this.disposed) {
        this.request = undefined
        if (retry) this.retrying = false
        this.change(this.value, this.retrying, this.readError)
        if (delay && this.visible) this.timer = setTimeout(() => this.refresh(), delay)
      }
    }
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
    this.request?.abort()
  }
}
