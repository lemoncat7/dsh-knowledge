/** One request owner per view: navigation, retry and pagination invalidate older work. */
export class LatestRequest {
  private current: AbortController | undefined

  start(): AbortSignal {
    this.cancel()
    this.current = new AbortController()
    return this.current.signal
  }

  cancel(): void {
    this.current?.abort()
    this.current = undefined
  }
}
