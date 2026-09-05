/** Cache successful model discovery; share in-flight reads and allow retry after failure. */
export function createModelCatalogLoader(request = fetch, ttlMs = 60000) {
  let cached
  let expires = 0
  let pending
  return function load() {
    if (cached !== undefined && Date.now() < expires) return Promise.resolve(cached)
    if (pending) return pending
    pending = (async () => {
      const response = await request('/knowledge-control/v1/models', {
        headers: { accept: 'application/json', 'x-dsh-knowledge-client': 'management-web' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (!Array.isArray(payload.providers)) throw new Error('模型目录返回了无效数据')
      cached = payload.providers
      expires = Date.now() + ttlMs
      return cached
    })().finally(() => { pending = undefined })
    return pending
  }
}
