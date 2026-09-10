/** One bounded metadata poll for the active document; no full-library reloads. */
export function createDocumentSync({ current, check, refresh, notify, visible = () => !document.hidden, interval = 5000 }) {
  let timer, controller, stopped = false, failures = 0
  const same = target => {
    const active = current()
    return active && active.identity === target.identity && active.version === target.version && active.key === target.key
  }
  async function tick() {
    clearTimeout(timer)
    if (stopped || controller) return
    const target = visible() ? current() : null
    if (!target) return schedule()
    controller = new AbortController()
    const timeout = setTimeout(() => controller?.abort(), 10000)
    try {
      const remote = await check(target, controller.signal)
      if (stopped || !visible() || !same(target)) return
      failures = 0
      if (remote.version !== target.version || remote.updatedAt !== target.updatedAt) {
        if (current().busy()) notify(target, 'changed')
        else await refresh(target, controller.signal, () => !stopped && visible() && same(target) && !current().busy())
      } else notify(target, 'current')
    } catch (error) {
      if (!stopped && same(target)) {
        failures++
        notify(target, error.status === 404 ? 'missing' : 'offline')
      }
    } finally {
      clearTimeout(timeout)
      controller = null
      schedule()
    }
  }
  function schedule() {
    clearTimeout(timer)
    if (!stopped && visible()) timer = setTimeout(tick, Math.min(30000, interval * 2 ** Math.min(failures, 3)))
  }
  return {
    wake() { if (!stopped) void tick() },
    pause() { clearTimeout(timer); controller?.abort() },
    stop() { stopped = true; clearTimeout(timer); controller?.abort() },
  }
}
