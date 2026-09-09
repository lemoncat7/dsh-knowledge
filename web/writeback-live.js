// Shared by visible conversation turns; the iframe owns its own single channel.
const groups = new Map()
export function subscribeWritebackChanges(client, listener) {
  let group = groups.get(client)
  if (!group) {
    const listeners = new Set()
    let stopped = false, request, timer, revision = '', failures = 0
    function emit() { for (const fn of listeners) fn() }
    async function poll() {
      if (stopped || document.hidden) return
      const controller = new AbortController()
      request = controller
      try {
        const response = await fetch(`/knowledge-control/v1/writeback-changes?since=${encodeURIComponent(revision)}`, {
          credentials: 'same-origin', cache: 'no-store', headers: { 'x-dsh-knowledge-client': client },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]),
        })
        if (!response.ok) throw new Error('notification transport unavailable')
        const data = await response.json()
        if (typeof data.revision !== 'string') throw new Error('invalid revision')
        if (stopped || controller.signal.aborted) return
        const changed = revision !== data.revision || failures > 0
        revision = data.revision
        failures = 0
        if (changed) emit()
      } catch { if (!controller.signal.aborted) failures++ }
      finally {
        if (request === controller) {
          request = undefined
          if (!stopped && !document.hidden) timer = setTimeout(poll, failures ? Math.min(30000, 1000 * 2 ** Math.min(failures, 5)) : 0)
        }
      }
    }
    function resume() {
      clearTimeout(timer)
      request?.abort()
      request = undefined
      if (!document.hidden && !stopped) { emit(); void poll() }
    }
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('online', resume)
    group = { listeners, close() { stopped = true; clearTimeout(timer); request?.abort(); document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', resume) } }
    groups.set(client, group)
    // Let the first caller attach before the initial revision arrives.
    timer = setTimeout(poll, 0)
  }
  group.listeners.add(listener)
  return () => {
    group.listeners.delete(listener)
    if (!group.listeners.size) { group.close(); groups.delete(client) }
  }
}
