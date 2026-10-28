/** Connection metadata only: never caches credentials, documents or access grants. */
const CONNECTION_CONTROL_PATH = '/knowledge-control/v1/connection'

export interface KnowledgeConnectionView {
  backend: 'local' | 'remote'
  remoteUrl?: string
  remoteTimeoutMs: number
  tokenConfigured: boolean
  canSwitchRemote: boolean
  writable: boolean
  managementAvailable: boolean
  managementPath?: string
}

export class ConnectionRequestError extends Error {
  constructor(message: string, readonly status = 0) { super(message) }
}

export function isConnectionView(value: unknown): value is KnowledgeConnectionView {
  if (value === null || typeof value !== 'object') return false
  const item = value as Partial<KnowledgeConnectionView>
  return (item.backend === 'local' || item.backend === 'remote')
    && Number.isInteger(item.remoteTimeoutMs)
    && typeof item.tokenConfigured === 'boolean'
    && typeof item.canSwitchRemote === 'boolean'
    && typeof item.writable === 'boolean'
    && typeof item.managementAvailable === 'boolean'
    && (!item.managementAvailable || (typeof item.managementPath === 'string'
      && item.managementPath.startsWith('/') && !item.managementPath.startsWith('//')))
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError')
}

/** A subscriber can cancel without cancelling other consumers of the same read. */
function observe<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { cleanup(); reject(abortReason(signal)) }
    const cleanup = (): void => { signal.removeEventListener('abort', abort) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

export function createConnectionClient(options: {
  fetch?: typeof fetch
  readTimeoutMs?: number
  now?: () => number
} = {}) {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? Date.now
  let cached: { value: KnowledgeConnectionView; at: number } | undefined
  let revision = 0
  let inflight: { promise: Promise<KnowledgeConnectionView>; controller: AbortController; consumers: number; revision: number } | undefined
  const writes = new Set<Promise<unknown>>()

  async function transport(method: 'GET' | 'PUT', body?: Record<string, unknown>, signal?: AbortSignal): Promise<KnowledgeConnectionView> {
    const response = await fetcher(CONNECTION_CONTROL_PATH, {
      method, cache: 'no-store',
      headers: { accept: 'application/json', ...body === undefined ? {} : { 'content-type': 'application/json' } },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      ...signal === undefined ? {} : { signal },
    })
    const payload: unknown = await response.json().catch(() => undefined)
    if (signal?.aborted) throw abortReason(signal)
    if (!response.ok) {
      const message = payload !== null && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error : `连接接口返回 HTTP ${response.status}`
      throw new ConnectionRequestError(message, response.status)
    }
    if (!isConnectionView(payload)) throw new ConnectionRequestError('插件连接接口返回了无效数据。')
    return payload
  }

  async function read(signal?: AbortSignal): Promise<KnowledgeConnectionView> {
    if (signal?.aborted) throw abortReason(signal)
    // Do not read half-switched connection settings or let an older GET undo a PUT.
    if (writes.size) {
      await observe(Promise.allSettled([...writes]), signal)
      return read(signal)
    }
    if (!inflight) {
      const controller = new AbortController()
      const version = revision
      const timer = setTimeout(() => controller.abort(new ConnectionRequestError('确认知识库连接超时，请重试。')), options.readTimeoutMs ?? 30_000)
      const promise = observe(transport('GET', undefined, controller.signal), controller.signal)
        .then(value => {
          if (!controller.signal.aborted && revision === version) cached = { value, at: now() }
          return value
        }).catch(error => {
          if (revision === version && error instanceof ConnectionRequestError && [401, 403, 404].includes(error.status)) cached = undefined
          throw error
        }).finally(() => {
          clearTimeout(timer)
          if (inflight?.promise === promise) inflight = undefined
        })
      inflight = { promise, controller, consumers: 0, revision: version }
    }
    const request = inflight
    request.consumers++
    try {
      const value = await observe(request.promise, signal)
      return request.revision === revision ? value : await read(signal)
    } catch (error) {
      if (!signal?.aborted && request.revision !== revision) return await read(signal)
      throw error
    } finally {
      request.consumers--
      if (request.consumers === 0) {
        request.controller.abort()
        if (inflight === request) inflight = undefined
      }
    }
  }

  async function write(body?: Record<string, unknown>, signal?: AbortSignal): Promise<KnowledgeConnectionView> {
    if (signal?.aborted) throw abortReason(signal)
    const previousRead = inflight
    revision++
    cached = undefined
    inflight = undefined
    // Writes are never replayed or given a read timeout: the server may have committed.
    const promise = transport('PUT', body, signal)
    writes.add(promise)
    previousRead?.controller.abort()
    try { return await promise } finally {
      writes.delete(promise)
      revision++
      cached = undefined
      inflight = undefined
    }
  }

  return {
    // Only speeds up the first paint. Each mount still revalidates against the server.
    peek: (): KnowledgeConnectionView | undefined => cached && now() - cached.at < 30_000 ? cached.value : undefined,
    request: (method: 'GET' | 'PUT', body?: Record<string, unknown>, signal?: AbortSignal) => method === 'GET' ? read(signal) : write(body, signal),
  }
}
