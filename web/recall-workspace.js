const priorities = [[-2, '低'], [-1, '较低'], [0, '标准'], [1, '较高'], [2, '高']]
const time = value => value ? new Date(value).toLocaleString('zh-CN') : '尚未召回'

export function createRecallWorkspace({ api, element: el, actionButton: button, openModal, openDocument, filters = {} }) {
  Object.assign(filters, { days: filters.days ?? 30, base: filters.base || '', query: filters.query || '', sort: filters.sort || 'recalls' })
  let disposed = false, request, generation = 0, items = [], cursor = '', total = 0, canManage = false, selected = new Set()
  const dialogs = new Set()
  const modal = options => {
    let current
    current = openModal({ ...options, onClose: () => { dialogs.delete(current); options.onClose?.() } })
    dialogs.add(current); return current
  }
  const info = el('span', { role: 'status' }), error = el('p', { class: 'recall-error', role: 'alert', hidden: true })
  const rows = el('tbody'), list = el('div', { class: 'recall-table-wrap' })
  const more = button('加载更多', () => load(false), 'ghost small', { 'data-load-more': 'auto' })
  const count = el('span', { role: 'status' })
  const options = (values, value, change, label) => el('select', { class: 'input', 'aria-label': label, onChange: change }, values.map(([id, name]) => el('option', { value: id, selected: String(id) === String(value) }, name)))
  const period = options([[7, '近 7 天'], [30, '近 30 天'], [0, '全部时间']], filters.days, e => { filters.days = Number(e.target.value); load(true) }, '统计时间')
  const bases = options([['', '全部知识库']], filters.base, e => { filters.base = e.target.value; load(true) }, '筛选知识库')
  const sort = options([['recalls', '按召回次数'], ['friction', '按摩擦系数'], ['priority', '按人工优先级'], ['reads', '按模型阅读'], ['recent', '按最近召回']], filters.sort, e => { filters.sort = e.target.value; load(true) }, '排行排序')
  const search = el('input', { class: 'input', type: 'search', value: filters.query, placeholder: '搜索知识文档', 'aria-label': '搜索知识文档' })
  const form = el('form', { class: 'recall-toolbar', onSubmit: e => { e.preventDefault(); filters.query = search.value.trim(); load(true) } }, search, button('搜索', () => { filters.query = search.value.trim(); load(true) }, 'small'), bases, period, sort, button('刷新', () => load(true), 'ghost small'))
  const bulk = el('div', { class: 'recall-bulk', hidden: true })
  const root = el('section', { class: 'recall-workspace' }, form, el('div', { class: 'recall-summary' }, info, el('details', {}, el('summary', {}, '统计与排序说明'), el('p', {}, '仅统计升级后成功上报的 AI 召回与阅读；候选搜索、人工浏览不计入。同一会话同一轮去重。自动注入和主动搜索可能同时发生，两者不直接相加。'), el('p', {}, '原始相关性决定能否召回；同等相关性内参考优先级、摩擦系数和近期使用。摩擦按独立踩坑的严重程度累计，90 天半衰减，保留 25% 防踩坑权重；已解决不清零。手动系数覆盖自动值。'))), error, bulk, list, el('div', { class: 'list-load-footer' }, count, more))
  list.append(el('table', { class: 'recall-table' }, el('thead', {}, el('tr', {}, ['', '知识文档', '召回', '会话', '阅读', '摩擦', '优先级', '操作'].map(name => el('th', { scope: 'col' }, name || el('span', { class: 'visually-hidden' }, '选择'))))), rows))

  function updateBulk() {
    bulk.hidden = !selected.size || !canManage
    bulk.replaceChildren(el('span', {}, `已选 ${selected.size} 篇`), ...priorities.map(([priority, name]) => button(name, async () => {
      const targets = items.filter(row => selected.has(row.id))
      bulk.querySelectorAll('button').forEach(node => { node.disabled = true })
      try { await api('recall/preferences', { method: 'POST', body: { items: targets.map(row => ({ id: row.id, revision: row.revision })), priority } }); await load(true) }
      catch (e) { error.hidden = false; error.textContent = e.message }
      finally { bulk.querySelectorAll('button').forEach(node => { node.disabled = false }) }
    }, 'ghost small')), button('取消选择', () => { selected.clear(); rows.querySelectorAll('input').forEach(node => { node.checked = false }); updateBulk() }, 'ghost small'))
  }
  function row(item) {
    return el('tr', { 'data-recall-id': item.id },
      el('td', {}, canManage ? el('input', { type: 'checkbox', 'aria-label': `选择 ${item.title}`, onChange: e => { if (e.target.checked) selected.add(item.id); else selected.delete(item.id); updateBulk() } }) : null),
      el('td', { class: 'recall-name' }, button(item.title, () => openDocument(item), 'ghost recall-title'), el('small', {}, `${item.baseName}${item.documentState === 'resolved' ? ' · 已解决' : item.documentState === 'complete' ? ' · 已收集完成' : ''}`)),
      el('td', {}, button(String(item.recalls), () => details(item, 'usage'), 'ghost small', { 'aria-label': `${item.title} 召回记录`, title: `最近召回：${time(item.lastRecall)}` })),
      el('td', {}, item.sessions), el('td', {}, item.reads),
      el('td', {}, button(item.friction.toFixed(1), () => details(item, 'incidents'), 'ghost small', { 'aria-label': `${item.title} 摩擦记录`, title: item.frictionOverride === null ? '自动计算' : '手动系数' }), item.frictionOverride === null ? null : el('small', {}, '手动')),
      el('td', {}, canManage ? button(priorities.find(([value]) => value === item.priority)?.[1] || '标准', () => settings(item), 'ghost small', { 'aria-label': `${item.title} 召回设置` }) : priorities.find(([value]) => value === item.priority)?.[1]),
      el('td', {}, canManage ? button('记一次踩坑', () => incident(item), 'ghost small') : button('详情', () => details(item, 'usage'), 'ghost small')))
  }
  function footer() { count.textContent = `已显示 ${items.length} / ${total} 篇`; more.hidden = !cursor; more.disabled = !!request }
  async function load(reset) {
    if (disposed || (!reset && (request || !cursor))) return
    if (reset) { generation++; request?.abort(); selected.clear(); updateBulk(); list.inert = true; cursor = '' }
    const current = generation, controller = new AbortController(); request = controller
    root.setAttribute('aria-busy', 'true'); more.disabled = true; error.hidden = true
    const params = new URLSearchParams({ days: filters.days, base: filters.base, q: filters.query, sort: filters.sort, limit: 30 })
    if (!reset && cursor) params.set('cursor', cursor)
    try {
      const data = await api(`recall?${params}`, { signal: controller.signal })
      if (disposed || current !== generation) return
      canManage = data.canManage
      list.inert = false
      if (reset) { items = []; rows.replaceChildren() }
      const known = new Set(items.map(item => item.id)), added = data.items.filter(item => !known.has(item.id))
      items.push(...added); rows.append(...added.map(row)); total = data.total; cursor = data.nextCursor || ''
      info.textContent = `${total} 篇知识文档 · 统计始于 ${new Date(data.startedAt).toLocaleDateString('zh-CN')}`
      if (!items.length) rows.append(el('tr', {}, el('td', { colspan: 8, class: 'recall-empty' }, '没有匹配的知识文档')))
      more.dataset.loadMore = 'auto'
    } catch (e) {
      if (!controller.signal.aborted && !disposed) { error.hidden = false; error.replaceChildren(el('span', {}, e.status === 404 ? '中央知识库尚不支持召回排行，请先升级服务端。' : e.message), button('重试', () => load(reset), 'ghost small')); more.dataset.loadMore = 'manual' }
    } finally { if (request === controller) { request = null; root.setAttribute('aria-busy', 'false'); footer() } }
  }
  function settings(item) {
    const priority = options(priorities, item.priority, () => {}, '召回优先级')
    const coefficient = el('input', { type: 'number', min: 0, max: 100, step: '.1', value: item.frictionOverride ?? item.automaticFriction, class: 'input', 'aria-label': '摩擦系数', disabled: item.frictionOverride === null })
    const mode = options([['auto', '按踩坑记录自动计算'], ['manual', '手动指定系数']], item.frictionOverride === null ? 'auto' : 'manual', e => { coefficient.disabled = e.target.value === 'auto' }, '摩擦系数模式')
    const reason = el('textarea', { rows: 3, maxlength: 500, class: 'input', placeholder: '调整摩擦系数时必填', 'aria-label': '调整原因' })
    const body = el('div', { class: 'recall-form' }, el('label', {}, '召回优先级', priority), el('label', {}, '摩擦计算方式', mode), el('label', {}, '摩擦系数 · 0–100', coefficient), el('label', {}, '调整原因', reason), button('恢复默认设置', () => { priority.value = '0'; mode.value = 'auto'; coefficient.disabled = true; reason.value = '恢复默认优先级及自动摩擦系数'; priority.dispatchEvent(new Event('change', { bubbles: true })) }, 'ghost small'))
    modal({ title: '召回设置', description: item.title, body, primaryLabel: '保存', onPrimary: async () => {
      const frictionOverride = mode.value === 'auto' ? null : Number(coefficient.value)
      if (mode.value === 'manual' && (!coefficient.value.trim() || !coefficient.checkValidity())) throw new Error('摩擦系数必须在 0–100 之间')
      await api(`recall/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: { priority: Number(priority.value), frictionOverride, revision: item.revision, reason: reason.value.trim() } })
      await load(true); return true
    } })
  }
  function incident(item) {
    const requestId = crypto.randomUUID(), reason = el('textarea', { class: 'input', rows: 4, maxlength: 1000, required: true, 'aria-label': '踩坑原因', placeholder: '这次发生了什么？与上一次是否为独立事件？' })
    const severity = options([[1, '普通返工 · 10 分'], [3, '任务阻塞 · 30 分'], [6, '严重事故 / 损失风险 · 60 分']], 1, () => {}, '严重程度')
    modal({ title: '记录一次踩坑', description: item.title, body: el('div', { class: 'recall-form' }, el('label', {}, '发生了什么', reason), el('label', {}, '严重程度', severity), el('p', { class: 'muted' }, '只记录这次独立发生的问题，重复讨论和重试不重复记分。')), primaryLabel: '记录', onPrimary: async () => {
      if (!reason.value.trim()) throw new Error('请填写踩坑原因')
      await api(`recall/${encodeURIComponent(item.id)}/incidents`, { method: 'POST', body: { requestId, reason: reason.value.trim(), severity: Number(severity.value) } })
      await load(true); return true
    } })
  }
  function details(item, initialKind) {
    let kind = initialKind, before = '', loading = false, controller, ended = false, sequence = 0
    const content = el('div', { class: 'recall-history' }), feedback = el('p', { role: 'status' })
    const next = button('加载更多记录', () => fetchRecords(false), 'ghost small')
    const tabs = el('div', { class: 'recall-detail-tabs' }, [['incidents', '踩坑记录'], ['usage', '召回记录'], ['changes', '调整记录']].map(([key, name]) => button(name, () => { kind = key; fetchRecords(true) }, 'small', { 'data-kind': key, 'aria-pressed': String(key === kind) })))
    modal({ title: '召回详情', description: item.title, body: el('div', {}, tabs, feedback, content, next), cancelLabel: '关闭', onClose: () => { ended = true; controller?.abort() } })
    async function fetchRecords(reset) {
      if (ended || (!reset && loading)) return
      const current = ++sequence; controller?.abort(); controller = new AbortController(); loading = true
      tabs.querySelectorAll('button').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.kind === kind)))
      if (reset) { before = ''; content.replaceChildren() }
      feedback.textContent = '正在读取记录…'; next.disabled = true
      const query = new URLSearchParams({ kind, ...(before ? { before } : {}) })
      try {
        const result = await api(`recall/${encodeURIComponent(item.id)}?${query}`, { signal: controller.signal })
        if (ended || current !== sequence) return
        before = result.nextCursor || ''; next.hidden = !before; next.textContent = '加载更多记录'; feedback.textContent = result.items.length ? '' : '暂无记录'
        content.append(...result.items.map(event => {
          const label = kind === 'usage' ? `${event.kind === 'read' ? '模型展开阅读' : [event.automatic ? '自动注入' : '', event.searched ? '主动搜索' : ''].filter(Boolean).join(' / ')} · 会话 ${event.session}` : event.reason
          return el('article', { class: 'recall-history-item' }, el('time', {}, time(event.at)), el('p', {}, label), kind === 'incidents' ? el('small', {}, `初始权重 ${event.severity * 10}${event.retracted_at ? ` · 已撤销：${event.retract_reason}` : ''}`) : null,
            kind === 'changes' ? el('p', { class: 'muted' }, changeLabel(event.value_json)) : null,
            kind === 'incidents' && !event.retracted_at && canManage ? button('撤销误记', () => {
              const reason = el('textarea', { class: 'input', rows: 3, maxlength: 500, 'aria-label': '撤销原因' })
              modal({ title: '撤销这次踩坑记录', body: el('label', { class: 'recall-form' }, '撤销原因', reason), primaryLabel: '确认撤销', onPrimary: async () => {
                await api(`recall/${encodeURIComponent(item.id)}/incidents/${event.id}/retract`, { method: 'POST', body: { reason: reason.value.trim() } }); await fetchRecords(true); await load(true); return true
              } })
            }, 'ghost small') : null)
        }))
      } catch (e) { if (!ended && current === sequence) { feedback.textContent = e.message; next.hidden = false; next.textContent = '重试读取' } }
      finally { if (current === sequence) { loading = false; next.disabled = false } }
    }
    fetchRecords(true)
  }
  function changeLabel(raw) {
    try { const { before, after } = JSON.parse(raw); return `优先级 ${priorities.find(([v]) => v === before.priority)?.[1]} → ${priorities.find(([v]) => v === after.priority)?.[1]}；摩擦 ${before.frictionOverride ?? '自动'} → ${after.frictionOverride ?? '自动'}` } catch { return '召回设置已调整' }
  }
  const baseController = new AbortController()
  api('knowledge-bases', { signal: baseController.signal }).then(values => {
    if (disposed) return
    bases.append(...values.filter(value => value.status === 'active').map(value => el('option', { value: value.id, selected: filters.base === value.id }, value.name)))
  }).catch(() => {})
  load(true)
  return { root, dispose() { disposed = true; request?.abort(); baseController.abort(); for (const dialog of dialogs) dialog.close(true) } }
}
