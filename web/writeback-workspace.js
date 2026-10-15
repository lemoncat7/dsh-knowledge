import { subscribeWritebackChanges } from './writeback-live.js'
/** Local outbox UI. Poll only this view, never reload the knowledge workspace. */
export function createWritebackWorkspace({ element, actionButton, openConfirm, sessionId = '' }) {
  const labels = { queued: '排队中', running: '回写中', failed: '失败', completed: '已完成', cancelled: '已取消' }
  let disposed = false, timer, request, busy = false, dirty = false, moreRequest
  let items = [], nextCursor = '', total = 0, initialized = false, generation = 0, watchOffset = 0, moreError = ''
  let failedOnly = false
  const failedButton = actionButton('只看失败', () => {
    failedOnly = !failedOnly
    failedButton.setAttribute('aria-pressed', String(failedOnly))
    reset()
  }, 'small', { 'aria-pressed': 'false' })
  const message = element('p', { role: 'status' })
  const list = element('div', { class: 'writeback-job-list' })
  const page = element('span', {})
  const filter = element('input', { class: 'input', value: sessionId, placeholder: '按会话编号筛选（可留空）', 'aria-label': '会话编号' })
  const nextButton = actionButton('加载更多', loadMore, 'ghost small', { 'data-load-more': 'auto', 'aria-label': '加载更多回写任务' })
  const root = element('section', { class: 'writeback-workspace' },
    element('p', {}, '本机回写队列。同一会话按顺序执行；网络中断会自动重试，连续失败可手动重试或取消。取消不会撤销已经写入的内容。'),
    element('div', { class: 'writeback-toolbar' }, filter, actionButton('筛选', () => { sessionId = filter.value.trim(); reset() }, 'small'), actionButton('刷新', reset, 'ghost small')),
    element('div', { class: 'writeback-toolbar' }, failedButton),
    message, list, element('div', { class: 'list-load-footer' }, page, nextButton))
  function params() { return new URLSearchParams({ sessionId, paged: '1', ...(failedOnly ? { status: 'failed' } : {}) }) }
  function reset() {
    generation++; request?.abort(); moreRequest?.abort(); moreRequest = undefined
    items = []; nextCursor = ''; total = 0; initialized = false; moreError = ''
    list.replaceChildren(); updateFooter(); void refresh()
  }
  function updateFooter() {
    page.textContent = moreError || `已显示 ${items.length} / ${total}`
    nextButton.hidden = !nextCursor
    nextButton.disabled = Boolean(moreRequest)
    nextButton.textContent = moreRequest ? '正在加载…' : moreError ? '重试加载' : '加载更多'
    nextButton.dataset.loadMore = moreError ? 'manual' : 'auto'
  }
  async function loadMore() {
    if (disposed || moreRequest || !nextCursor) return
    const controller = new AbortController(), current = generation
    moreRequest = controller; moreError = ''; updateFooter()
    try {
      const query = params(); query.set('cursor', nextCursor)
      const data = await fetchJson(query, 'GET', controller.signal)
      if (disposed || current !== generation) return
      const known = new Set(items.map(job => job.sourceKey))
      const added = data.items.filter(job => !known.has(job.sourceKey))
      items.push(...added); list.append(...added.map(renderJob))
      nextCursor = data.nextCursor || ''; total = data.total
    } catch (error) { if (!controller.signal.aborted && !disposed) moreError = error.message }
    finally { if (moreRequest === controller) { moreRequest = undefined; updateFooter() } }
  }
  async function fetchJson(params, method = 'GET', signal) {
    const response = await fetch(`/knowledge-control/v1/writeback-jobs?${params}`, { method, credentials: 'same-origin', headers: { 'x-dsh-knowledge-client': 'management-web' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || `读取回写队列失败（${response.status}）`)
    return data
  }
  async function operate(job, action) {
    if (busy || disposed) return
    busy = true
    request?.abort()
    message.textContent = action === 'cancel' ? '正在请求取消…' : '正在提交重试…'
    try {
      const result = await fetchJson(new URLSearchParams({ action, sourceKey: job.sourceKey }), 'POST')
      message.textContent = result.summary
      // Refresh status in place; preserve the loaded history and scroll position.
    } catch (error) { message.textContent = error.message }
    finally { busy = false; if (!disposed) void refresh(true) }
  }
  function renderJob(job) {
    const actions = element('div', { class: 'writeback-toolbar' })
    if (job.status === 'failed') actions.append(actionButton('重试', () => operate(job, 'retry'), 'small'))
    if (['queued', 'running', 'failed'].includes(job.status)) actions.append(actionButton(job.cancelRequested ? '取消中…' : '取消回写', () => openConfirm({ title: '取消这条回写？', message: '取消后不再重试，并允许后续轮次继续。已经写入的内容不会撤销。', confirmLabel: '取消回写', danger: true, onConfirm: () => operate(job, 'cancel') }), 'ghost small', { disabled: job.cancelRequested }))
    return element('article', { class: 'writeback-job', 'data-job-key': job.sourceKey },
      element('div', { class: 'writeback-toolbar' }, element('strong', {}, labels[job.status] || job.status), element('span', {}, `已尝试 ${job.attempts} 次`), actions),
      element('div', { class: 'writeback-job-key', title: job.sourceKey }, job.sourceKey),
      job.createdAt ? element('p', {}, '创建于 ', element('time', { datetime: new Date(job.createdAt).toISOString() }, new Date(job.createdAt).toLocaleString())) : element('p', {}, '历史任务 · 创建时间未记录'),
      element('p', {}, job.summary),
      job.blockedBy ? element('p', {}, `阻塞任务：${job.blockedBy}`) : null,
      job.nextAttemptAt ? element('p', {}, `下次自动重试：${new Date(job.nextAttemptAt).toLocaleString()}`) : null,
      job.error ? element('details', {}, element('summary', {}, '失败原因'), element('pre', {}, job.error)) : null,
      ...(job.destinations || []).map(destination => element('p', {}, `${destination.knowledgeBaseName} / ${destination.documentTitle || destination.documentId || ''}`)))
  }
  async function refresh(preserveMessage = false) {
    clearTimeout(timer)
    if (disposed || document.hidden || busy) return
    dirty = false
    request?.abort()
    const controller = new AbortController()
    request = controller
    try {
      const query = params()
      // Only refresh a bounded batch of active historical jobs, not all loaded pages.
      const active = items.filter(job => ['queued', 'running', 'failed'].includes(job.status))
      if (watchOffset >= active.length) watchOffset = 0
      for (const job of active.slice(watchOffset, watchOffset + 30)) query.append('watch', job.sourceKey)
      watchOffset += 30
      const data = await fetchJson(query, 'GET', controller.signal)
      if (disposed || request !== controller) return
      if (!initialized) {
        items = data.items; nextCursor = data.nextCursor || ''; initialized = true
        list.replaceChildren(...(items.length ? items.map(renderJob) : [element('p', {}, failedOnly ? '当前范围没有失败的回写任务' : '没有回写任务')]))
      } else {
        const updates = new Map([...data.items, ...(data.updates || [])].map(job => [job.sourceKey, job]))
        const nodes = new Map([...list.children].map(node => [node.dataset.jobKey, node]))
        items = items.flatMap(job => {
          const next = updates.get(job.sourceKey)
          if (!next) return [job]
          if (failedOnly && next.status !== 'failed') { nodes.get(job.sourceKey)?.remove(); return [] }
          if (JSON.stringify(next) !== JSON.stringify(job)) nodes.get(job.sourceKey)?.replaceWith(renderJob(next))
          return [next]
        })
      }
      total = data.total; updateFooter()
      if (!preserveMessage) message.textContent = data.items.some(job => !items.some(item => item.sourceKey === job.sourceKey)) ? '有新任务，点击刷新查看；当前记录状态继续更新' : '状态自动更新'
    } catch (error) { if (!controller.signal.aborted && !disposed) message.textContent = `${error.message}；将自动重连` }
    finally { if (request === controller) { request = undefined; if (!disposed) timer = setTimeout(() => refresh(), dirty ? 0 : 5000) } }
  }
  function visibility() { if (document.hidden) { clearTimeout(timer); request?.abort() } else void refresh() }
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('online', visibility)
  const unsubscribeChanges = subscribeWritebackChanges('management-web', () => { if (request || busy) dirty = true; else void refresh() })
  void refresh()
  return { root, dispose() { disposed = true; clearTimeout(timer); request?.abort(); moreRequest?.abort(); unsubscribeChanges(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('online', visibility) } }
}
