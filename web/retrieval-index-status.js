/** Metadata-only status, independent of document rendering and editor state. */
export function indexStatusLabel(data) {
  if (!data) return '读取索引状态…'
  if (data.failed) return `${data.failed} 篇索引失败${data.pending ? ` · ${data.pending} 篇待处理` : ''}`
  if (data.pending) return `索引更新中 · ${data.ready} / ${data.total}`
  return data.total ? '索引已就绪' : '暂无文档需要索引'
}

export function createRetrievalIndexStatus({ api, element: el, actionButton: button, interfaceIcon: icon, openModal, sourceLabel = '当前知识库服务' }) {
  let scope = '', data, error = '', terminal = false, disposed = false, active = false, visible = true
  let timer, controller, modal, detailRoot, summary, list, feedback, tabs, pager, retryAll
  let selected = 'failed', offset = 0, busy = false, generation = 0, lastFetch = 0
  let detailKey = ''
  const label = el('span', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, indexStatusLabel())
  const trigger = button([icon('outline'), label, icon('chevron-right')], () => showDetails(), 'ghost retrieval-index-trigger', { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' })
  const root = el('div', { class: 'retrieval-index-status' }, trigger)

  function path(details = false, retry = false) {
    const params = new URLSearchParams(scope)
    if (details) { params.set('details', '1'); params.set('state', selected); params.set('offset', String(offset)) }
    return `retrieval-index${retry ? '/retry' : ''}?${params}`
  }
  function render() {
    const text = error ? '索引状态暂不可用' : indexStatusLabel(data)
    if (label.textContent !== text) label.textContent = text
    root.dataset.state = error ? 'unavailable' : data?.failed ? 'failed' : data?.pending ? 'pending' : 'ready'
    trigger.title = `${sourceLabel} · 当前目录范围 · ${text}`
    if (!modal) return
    summary.textContent = data ? `已就绪 ${data.ready} · 待处理 ${data.pending} · 失败 ${data.failed} · 共 ${data.total} 篇` : '正在读取服务状态…'
    feedback.textContent = error
    feedback.hidden = !error
    retryAll.disabled = busy || !data?.failed || !data?.canRetry || Boolean(error)
    retryAll.hidden = data?.canRetry === false
    for (const tab of tabs.children) tab.setAttribute('aria-pressed', String(tab.dataset.state === selected))
    const focusId = document.activeElement?.closest?.('[data-retry-id]')?.dataset.retryId
    const scroll = list.scrollTop
    list.replaceChildren()
    if (!error && detailKey !== `${selected}:${offset}`) list.append(el('p', { class: 'retrieval-index-empty' }, '正在读取任务明细…'))
    if (data && !error && detailKey === `${selected}:${offset}` && Array.isArray(data.items)) {
      for (const item of data.items) {
        const details = selected === 'failed'
          ? `索引构建失败，正文仍可检索${item.attempts ? ` · 已尝试 ${item.attempts} 次` : ''}${item.retryAt ? ` · 下次重试 ${new Date(item.retryAt).toLocaleString()}` : ''}`
          : '等待后台处理，无需手动操作'
        list.append(el('article', { class: 'retrieval-index-item' },
          el('div', {}, el('strong', {}, item.title || '未命名文档'),
            el('small', {}, [item.documentGroup, `文档版本 ${item.documentVersion}`].filter(Boolean).join(' · ')), el('p', {}, details)),
          selected === 'failed' && data.canRetry ? button('重试', () => retry(item.documentId), 'ghost small', { disabled: busy, 'data-retry-id': item.documentId, 'aria-label': `重试索引：${item.title}` }) : null))
      }
      if (!data.items.length) list.append(el('p', { class: 'retrieval-index-empty' }, selected === 'failed' ? '没有索引失败的文档。' : '没有待处理的文档。'))
    }
    list.scrollTop = scroll
    if (focusId) [...list.querySelectorAll('[data-retry-id]')].find(node => node.dataset.retryId === focusId)?.focus({ preventScroll: true })
    pager.replaceChildren(
      button('上一页', () => changePage(Math.max(0, offset - 30)), 'ghost small', { disabled: busy || offset === 0 }),
      el('span', {}, `第 ${Math.floor(offset / 30) + 1} 页`),
      button('下一页', () => changePage(offset + 30), 'ghost small', { disabled: busy || !data?.hasMore }))
    pager.hidden = !data || (!offset && !data.hasMore) || Boolean(error)
  }
  function stop() {
    clearTimeout(timer); timer = undefined
    controller?.abort(); controller = undefined
    generation++
  }
  function schedule() {
    clearTimeout(timer)
    if (!active || disposed || document.hidden || (!visible && !modal) || terminal) return
    timer = setTimeout(() => { void refresh() }, error ? 15000 : data?.pending || data?.failed ? 3000 : 30000)
  }
  async function refresh(force = false) {
    if (!active || disposed || document.hidden || (!visible && !modal) || (terminal && !force) || busy) return
    controller?.abort()
    const request = ++generation
    const abort = new AbortController(); controller = abort
    const timeout = setTimeout(() => abort.abort(), 10000)
    try {
      const result = await api(path(Boolean(modal)), { signal: abort.signal })
      if (request !== generation || disposed || !active) return
      if (!result || !['ready', 'pending', 'failed', 'total'].every(key => Number.isSafeInteger(result[key]) && result[key] >= 0)) throw new Error('索引状态格式无效')
      data = result; error = ''; terminal = false; lastFetch = Date.now()
      detailKey = modal ? `${selected}:${offset}` : ''
      if (modal && offset && !data.items?.length) { offset = 0; void refresh(); return }
      render()
    } catch (failure) {
      if (request !== generation || disposed || !active || document.hidden) return
      terminal = [401, 403, 404, 405, 501].includes(failure.status)
      error = failure.status === 404 || failure.status === 501 ? '当前知识库服务尚不支持索引状态，请升级实际存储文档的服务。'
        : failure.status === 401 || failure.status === 403 ? '当前连接没有查看索引状态的权限，请检查访问令牌。'
          : '暂时无法读取索引状态，不代表索引失败。请检查连接后刷新。'
      render()
    } finally { clearTimeout(timeout); if (request === generation) { controller = undefined; schedule() } }
  }
  function changePage(next) { offset = next; void refresh(true) }
  async function retry(documentId) {
    if (busy || !data?.canRetry) return
    busy = true; stop(); render()
    const request = generation
    const abort = new AbortController(); controller = abort
    const timeout = setTimeout(() => abort.abort(), 10000)
    try {
      await api(path(false, true), { method: 'POST', body: documentId ? { documentId } : {}, signal: abort.signal })
      if (request === generation) { offset = 0; error = ''; terminal = false }
    } catch {
      if (request === generation) error = '重试请求未确认，请刷新状态后再试；不会重新生成文档。'
    } finally {
      clearTimeout(timeout)
      busy = false
      if (request === generation) { controller = undefined; render(); if (!error) void refresh(true); else schedule() }
    }
  }
  function showDetails() {
    if (modal || disposed) return
    selected = data?.failed ? 'failed' : 'pending'; offset = 0; detailKey = ''
    summary = el('p', { class: 'retrieval-index-summary' })
    feedback = el('p', { class: 'retrieval-index-error', role: 'alert', hidden: true })
    retryAll = button('重试失败项', () => retry(), 'small')
    tabs = el('div', { class: 'retrieval-index-tabs', role: 'group', 'aria-label': '索引状态筛选' },
      ...[['pending', '待处理'], ['failed', '失败']].map(([state, title]) => button(title, () => { selected = state; offset = 0; render(); void refresh(true) }, 'ghost small', { 'data-state': state })))
    list = el('div', { class: 'retrieval-index-list', 'aria-label': '索引任务' })
    pager = el('div', { class: 'retrieval-index-pager' })
    detailRoot = el('div', { class: 'retrieval-index-detail' }, summary,
      el('p', { class: 'retrieval-index-hint' }, '已有和新增文档都会自动建立索引。处理期间仍可搜索；重试只重建索引，不修改正文。'),
      el('div', { class: 'retrieval-index-actions' }, tabs, button('刷新', () => { terminal = false; void refresh(true) }, 'ghost small'), retryAll), feedback, list, pager)
    modal = openModal({ title: '检索索引', description: `${sourceLabel} · 当前目录范围`, className: 'retrieval-index-dialog', body: detailRoot, cancelLabel: '关闭', onClose: () => {
      modal = undefined; trigger.setAttribute('aria-expanded', 'false'); stop(); schedule()
    } })
    trigger.setAttribute('aria-expanded', 'true')
    render(); void refresh(true)
  }
  const visibility = () => { if (document.hidden) stop(); else if (active) void refresh() }
  document.addEventListener('visibilitychange', visibility)
  const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
    const next = entries.some(entry => entry.isIntersecting)
    if (next === visible) return
    visible = next
    if (!visible && !modal) stop()
    else if (active) void refresh()
  })
  observer?.observe(root)
  return {
    root,
    mount(params) {
      const next = params.toString()
      if (scope !== next) { stop(); modal?.close(true); scope = next; data = undefined; error = ''; terminal = false; lastFetch = 0 }
      active = true; render()
      if (!controller && (!lastFetch || Date.now() - lastFetch >= 3000)) void refresh()
      else schedule()
      return root
    },
    suspend() { active = false; stop(); modal?.close(true) },
    dispose() { this.suspend(); disposed = true; observer?.disconnect(); document.removeEventListener('visibilitychange', visibility) },
  }
}
