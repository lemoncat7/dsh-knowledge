import { createWikiDirectoryBrowser } from "./wiki-directory-browser.js"
const STATUS_LABEL = { running: '运行中', paused: '已暂停', done: '已完成', cancelled: '已取消' }
const STAGE_LABEL = { new: '待归类', classified: '已归类', archived: '已归档', extracted: '待蒸馏', done: '已完成', review: '待人工确认', failed: '失败' }

/**
 * Wiki workspace for the management console.
 * Uses the shared layout, controls and dialog primitives; the operator never has to
 * paste a path, a Python executable or a model id by hand.
 */
export function createWikiWorkspace({ api, element, actionButton, badge, interfaceIcon, openModal, bases }) {
  const root = element('section', { class: 'wiki-workspace' })
  const state = { kbId: '', configs: [], pages: [], page: undefined, standard: undefined, dirty: false }
  const status = element('p', { class: 'wiki-status', role: 'status', 'aria-live': 'polite' })
  let busy = false
  let disposed = false, generation = 0
  const connectionView = element('div', { class: 'wiki-connection', role: 'status' })
  let directorySettings, connectTitle, dailySection
  const requestControllers = new Set()
  const call = async (path, options = {}) => {
    const token = generation, controller = new AbortController()
    requestControllers.add(controller)
    try {
      const value = await api(path, { ...options, signal: controller.signal })
      if (disposed || token !== generation) throw new Error('WIKI_VIEW_CHANGED')
      return value
    } finally { requestControllers.delete(controller) }
  }

  const baseSelect = element('select', { class: 'select', 'aria-label': '选择知识库' }, bases.map(b => element('option', { value: b.id }, b.name)))
  const sourceInput = element('input', { class: 'input', placeholder: '原件投放与归档目录', 'aria-label': '原件目录' })
  const workspaceInput = element('input', { class: 'input', placeholder: 'Wiki 工作区目录', 'aria-label': '工作区目录' })
  const rawInput = element('input', { class: 'input', placeholder: '留空则使用工作区/raw', 'aria-label': 'raw 目录' })
  const conversationToggle = element('input', { type: 'checkbox' })
  const scopeSelect = element('select', { class: 'select', 'aria-label': '范围' },
    element('option', { value: 'project' }, '项目范围'),
    element('option', { value: 'global' }, '全局范围'))
  const projectInput = element('input', { class: 'input', placeholder: '项目 ID / 路径（项目范围必填）', 'aria-label': '项目编号' })

  const pythonSelect = element('select', { class: 'select', 'aria-label': 'Python 解释器' })
  const pythonNote = element('p', { class: 'wiki-hint' })
  const providerSelect = element('select', { class: 'select', 'aria-label': '模型 provider' })
  const modelSelect = element('select', { class: 'select', 'aria-label': '模型' })
  const consentToggle = element('input', { type: 'checkbox' })

  const pageList = element('div', { class: 'wiki-list' })
  const jobList = element('div', { class: 'wiki-list' })
  const proposalList = element('div', { class: 'wiki-list' })
  const rawList = element('div', { class: 'wiki-list wiki-raw-list' })
  const rawView = element('pre', { class: 'wiki-pre', hidden: true })
  const rawSummary = element('summary', {}, 'raw 产物（只读）· 展开后加载')
  const rawFilter = element('input', { class: 'input', type: 'search', placeholder: '筛选 raw 文件名', 'aria-label': '筛选 raw 文件' })
  const rawNote = element('p', { class: 'wiki-hint' })
  const rawDetails = element('details', { class: 'wiki-details wiki-raw' }, rawSummary, rawFilter, rawNote, rawList, rawView)
  // Editing and diagnostics stay available but out of the everyday AI-driven flow.
  let pagesLoaded = false
  let rawLoaded = false
  let rawEntries = []
  let progressTimer
  let progressWasRunning = false
  let progressFailures = 0
  const RAW_PAGE = 100
  const editor = element('textarea', { class: 'textarea wiki-editor', rows: 22, spellcheck: 'false', 'aria-label': 'Markdown 编辑器' })
  const editorTitle = element('strong', { class: 'wiki-editor-title' }, '未选择文件')
  const saveButton = actionButton('保存当前文件', () => void run(save), 'small')
  saveButton.disabled = true
  const advancedDetails = element('details', { class: 'wiki-details wiki-advanced' },
    element('summary', {}, '高级：手工编辑与诊断（一般不需要）'),
    element('div', { class: 'wiki-columns' },
      element('div', { class: 'wiki-column' }, element('h3', {}, 'Wiki 页面'), pageList),
      element('div', { class: 'wiki-column' }, rawDetails)),
    element('div', { class: 'wiki-editor-bar' }, editorTitle, actionButton('打开文档标准', () => void run(openStandard), 'ghost small'), saveButton),
    editor)

  const url = suffix => `wiki/${encodeURIComponent(state.kbId)}/${suffix}`
  const scope = () => scopeSelect.value === 'global' ? { kind: 'global' } : { kind: 'project', id: projectInput.value.trim() }
  const requireProject = () => {
    if (scopeSelect.value === 'project' && !projectInput.value.trim()) throw new Error('请先填写项目范围')
    return scope()
  }

  editor.addEventListener('input', () => { state.dirty = true; saveButton.disabled = false })
  rawDetails.addEventListener('toggle', () => { if (rawDetails.open && !rawLoaded) void run(loadRaw) })
  rawFilter.addEventListener('input', () => { if (rawLoaded) renderRaw() })
  advancedDetails.addEventListener('toggle', () => {
    if (!advancedDetails.open || pagesLoaded) return
    pagesLoaded = true
    void run(loadPages)
  })
  baseSelect.addEventListener('change', () => {
    const next = baseSelect.value
    if (busy || (state.dirty && !window.confirm('放弃未保存的内容并切换知识库？'))) {
      baseSelect.value = state.kbId
      return
    }
    generation++; window.clearTimeout(progressTimer)
    for (const controller of requestControllers) controller.abort()
    state.kbId = next
    state.page = undefined; state.standard = undefined; state.dirty = false; state.pages = []
    editor.value = ''; editorTitle.textContent = '未选择文件'; saveButton.disabled = true
    rawView.textContent = ''; rawView.hidden = true
    consentToggle.checked = false
    void run(reload)
  })

  async function run(action) {
    if (busy || disposed) return
    busy = true; baseSelect.disabled = true; root.setAttribute('aria-busy', 'true'); status.textContent = '处理中…'
    try { status.textContent = (await action()) ?? '已完成' }
    catch (error) { status.textContent = error.message }
    finally { busy = false; baseSelect.disabled = false; root.removeAttribute('aria-busy') }
  }

  function browse(input, label) {
    return createWikiDirectoryBrowser({ api: call, endpoint: url("browse"), element, actionButton, interfaceIcon, openModal,
      initial: input.value.trim(), label,
      onSelect: path => { input.value = path; input.dispatchEvent(new Event("input", { bubbles: true })); status.textContent = "已选择 " + path },
    })
  }

  const pathField = (input, label) => element('div', { class: 'wiki-path-field' },
    input,
    actionButton('选择目录', () => browse(input, label), 'ghost small', { 'aria-label': `选择${label}` }))

  async function refreshConfig() {
    state.configs = await call('wiki')
    const current = state.configs.find(entry => entry.kbId === state.kbId)
    sourceInput.value = current?.layout.sourceDir ?? ''
    workspaceInput.value = current?.layout.workspaceRoot ?? ''
    rawInput.value = current?.layout.rawDir ?? ''
    conversationToggle.checked = Boolean(current?.conversationEnabled)
    return current
  }

  async function loadPython() {
    const data = await call(url('python'))
    pythonSelect.replaceChildren(...(data.candidates.length
      ? data.candidates.map(candidate => element('option', { value: candidate.path },
        `${candidate.path}${candidate.version ? ` · ${candidate.version}` : ''}${candidate.ok ? '' : '（缺依赖）'}`))
      : [element('option', { value: '' }, '未检测到 Python')]))
    const best = data.candidates.find(candidate => candidate.ok) ?? data.candidates[0]
    if (best) pythonSelect.value = best.path
    pythonNote.textContent = data.hint || (best?.ok ? '依赖齐全，可直接使用。' : '')
    const installButton = pythonNote.parentElement?.querySelector('[data-python-install]')
    if (installButton) installButton.hidden = Boolean(best?.ok) || !best
  }

  async function loadModels() {
    const data = await call(url('models'))
    const providers = data.providers ?? []
    providerSelect.replaceChildren(...(providers.length
      ? providers.map(item => element('option', { value: item.provider }, item.name))
      : [element('option', { value: '' }, '未检测到可用模型渠道')]))
    const fill = () => {
      const provider = providers.find(item => item.provider === providerSelect.value)
      modelSelect.replaceChildren(...(provider?.models.length
        ? provider.models.map(model => element('option', { value: model.id }, model.name))
        : [element('option', { value: '' }, '该渠道没有返回模型')]))
    }
    providerSelect.onchange = fill
    if (data.default && providers.some(item => item.provider === data.default.provider)) {
      providerSelect.value = data.default.provider
      fill()
      if (providers.find(item => item.provider === data.default.provider)?.models.some(model => model.id === data.default.model)) modelSelect.value = data.default.model
    } else fill()
  }

  async function resetPages() {
    pagesLoaded = false
    pageList.replaceChildren()
    if (!advancedDetails.open) return
    pagesLoaded = true
    await loadPages()
  }

  async function loadPages() {
    pageList.replaceChildren()
    if (!state.configs.some(entry => entry.kbId === state.kbId)) {
      pageList.append(element('p', { class: 'muted' }, '该知识库还没有绑定 Wiki 目录。保存配置后可登记已有页面。'))
      return
    }
    state.pages = await call(url('pages'))
    if (!state.pages.length) { pageList.append(element('p', { class: 'muted' }, '还没有登记任何页面。')); return }
    for (const page of state.pages) {
      pageList.append(element('div', { class: 'wiki-row' },
        actionButton(page.relPath, () => void run(() => openPage(page)), 'ghost small'),
        badge(page.status === 'active' ? '使用中' : '已归档', page.status === 'active' ? 'success' : ''),
        element('span', { class: 'muted' }, `${page.provenance?.kind ?? 'unknown'} · v${page.version}`)))
    }
  }

  function stageSummary(job) {
    const total = job.items.length
    const done = job.items.filter(item => item.stage === 'done').length
    const failed = job.items.filter(item => item.stage === 'failed').length
    const review = job.items.filter(item => item.stage === 'review').length
    const current = job.state === 'running' ? job.items.find(item => !['done', 'review'].includes(item.stage)) : undefined
    const parts = [`完成 ${done}/${total}`]
    if (failed) parts.push(`失败 ${failed}`)
    if (review) parts.push(`待人工 ${review}`)
    if (current) parts.push(`当前：${current.source.split(/[\\/]/).pop()}（${STAGE_LABEL[current.stage] ?? current.stage}）`)
    return parts.join(' · ')
  }

  function drawJobs(jobs) {
    jobList.replaceChildren()
    if (!jobs.length) { jobList.append(element('p', { class: 'muted' }, '还没有入库任务。')); return }
    for (const job of jobs) {
      const head = element('div', { class: 'wiki-row' },
        element('strong', {}, `任务 ${job.id.slice(0, 8)}`),
        badge(STATUS_LABEL[job.state] ?? job.state, job.state === 'done' ? 'success' : job.state === 'paused' ? 'warning' : ''),
        element('span', { class: 'muted' }, job.discovery ? `发现 ${job.discovery.found} 个，跳过 ${job.discovery.duplicates} 个已处理` : ''),
        actionButton('刷新', () => void run(loadJobs), 'ghost small'),
        actionButton('续跑', () => void run(async () => { await call(url(`job/${job.id}`), { method: 'POST', body: { action: 'resume' } }); await loadJobs() }), 'ghost small'),
        actionButton('取消', () => void run(async () => { await call(url(`job/${job.id}`), { method: 'POST', body: { action: 'cancel' } }); await loadJobs() }), 'ghost small'))
      const progress = element('p', { class: job.state === 'running' ? 'wiki-progress is-running' : 'wiki-progress', 'aria-live': 'polite' }, stageSummary(job))
      const detail = element('div', { class: 'wiki-job-items' })
      for (const item of job.items) {
        const row = element('div', { class: 'wiki-row wiki-row-detail' },
          element('span', { class: 'wiki-path', title: item.source }, item.source.split(/[\\/]/).pop()),
          badge(STAGE_LABEL[item.stage] ?? item.stage, item.stage === 'failed' ? 'danger' : item.stage === 'review' ? 'warning' : item.stage === 'done' ? 'success' : ''),
          item.error ? element('small', { class: 'wiki-error' }, item.error) : null)
        if (item.stage === 'review') {
          row.append(actionButton('指定分类', () => void run(async () => {
            const category = window.prompt('输入分类文件夹名')
            if (!category) return
            await call(url(`job/${job.id}`), { method: 'POST', body: { action: 'classify', itemId: item.id, category } })
            await loadJobs()
          }), 'ghost small'))
        }
        if (item.stage === 'done' && !item.pages?.length) row.append(element('small', { class: 'wiki-hint' }, '已记录处理结果，未生成知识页'))
        if (item.error?.includes('WIKI_DISTILL_UPDATE_REQUIRES_REVIEW')) row.append(element('small', { class: 'wiki-hint' }, '已有页面的修改候选待审核，尚未替换原文'))
        for (const path of item.pages ?? []) row.append(actionButton('查看关联页：' + path, () => void run(async () => {
          const pages = await call(url('pages'))
          const page = pages.find(page => page.relPath === path)
          if (!page) throw new Error('关联页面未登记，请刷新索引后再试')
          const value = await call(url(`page/${encodeURIComponent(page.pageId)}`))
          openModal({ title: 'AI 处理结果 · ' + path, body: element('pre', { class: 'wiki-pre' }, value.content), cancelLabel: '关闭' })
          return '已打开只读处理结果'
        }), 'ghost small'))
        detail.append(row)
      }
      jobList.append(element('div', { class: 'wiki-card' }, head, progress, detail))
    }
  }

  async function loadJobs(options = {}) {
    const jobs = await call(url('jobs'))
    drawJobs(jobs)
    if (!options.quiet) scheduleProgress(jobs)
    return null
  }

  /** While a job runs, refresh the card so stage changes are visible without clicking. */
  function scheduleProgress(jobs) {
    window.clearTimeout(progressTimer)
    const token = generation
    const running = jobs.some(job => job.state === 'running')
    if (disposed || !running || !root.isConnected) { if (!running) progressWasRunning = false; return }
    progressWasRunning = true
    progressTimer = window.setTimeout(async () => {
      if (disposed || token !== generation || !root.isConnected) return
      try {
        const next = await call(url('jobs'))
        progressFailures = 0
        drawJobs(next)
        const stillRunning = next.some(job => job.state === 'running')
        if (!stillRunning && progressWasRunning) { progressWasRunning = false; void loadPages().catch(() => {}) }
        scheduleProgress(next)
      } catch (error) {
        if (disposed || token !== generation) return
        progressFailures++
        status.textContent = `进度获取失败（${progressFailures}/3）：${error.message}；${progressFailures >= 3 ? '自动刷新已停止，请手动刷新任务' : '稍后重试'}`
        if (progressFailures < 3) scheduleProgress([{ state: 'running' }])
      }
    }, 2000 * Math.max(1, 2 ** progressFailures))
  }

  async function loadProposals() {
    proposalList.replaceChildren()
    const values = await call(url('proposals'))
    if (!values.length) { proposalList.append(element('p', { class: 'muted' }, '没有待审核的旧页更新。')); return }
    for (const proposal of values) {
      const card = element('div', { class: 'wiki-card' }, element('details', { class: 'wiki-details' },
        element('summary', {}, `${proposal.pageId.slice(0, 8)} · ${proposal.state === 'pending' ? '待审核' : proposal.state === 'approved' ? '已批准' : '已拒绝'}`),
        element('pre', { class: 'wiki-pre' }, proposal.content)))
      if (proposal.state === 'pending') {
        card.append(element('div', { class: 'wiki-actions' },
          actionButton('批准替换', () => void run(async () => { await call(url(`proposal/${proposal.id}`), { method: 'POST', body: { approve: true } }); await loadProposals() }), 'small'),
          actionButton('拒绝', () => void run(async () => { await call(url(`proposal/${proposal.id}`), { method: 'POST', body: { approve: false } }); await loadProposals() }), 'ghost small')))
      }
      proposalList.append(card)
    }
  }

  async function loadRaw() {
    rawList.replaceChildren(); rawView.hidden = true
    const entries = await call(url('raw'))
    rawEntries = entries
    rawLoaded = true
    rawSummary.textContent = `raw 产物（只读）· ${entries.length} 个文件`
    renderRaw()
  }

  function renderRaw() {
    rawList.replaceChildren()
    if (!rawEntries.length) { rawNote.textContent = 'raw 目录为空。'; return }
    const query = rawFilter.value.trim().toLocaleLowerCase()
    const matched = rawEntries.filter(entry => entry.path.toLocaleLowerCase().includes(query))
    if (!matched.length) { rawNote.textContent = '没有匹配的 raw 文件。'; return }
    const shown = matched.slice(0, RAW_PAGE)
    rawNote.textContent = matched.length > shown.length
      ? `匹配 ${matched.length} 个，显示前 ${shown.length} 个；可用筛选缩小范围。`
      : `匹配 ${matched.length} 个文件。`
    for (const entry of shown) {
      rawList.append(element('div', { class: 'wiki-row' },
        actionButton(entry.path, () => void run(() => showRaw(entry.path)), 'ghost small'),
        element('span', { class: 'muted' }, `${Math.round(entry.bytes / 1024)} KB`)))
    }
  }

  async function resetRaw() {
    rawEntries = []; rawLoaded = false; rawFilter.value = ''; rawNote.textContent = ''
    rawList.replaceChildren(); rawView.hidden = true
    rawSummary.textContent = 'raw 产物（只读）· 展开后加载'
    if (rawDetails.open) await loadRaw()
  }

  async function showRaw(path) {
    const first = await call(url('raw-content') + '?' + new URLSearchParams({ path, offset: '0' }))
    rawView.textContent = first.text
    rawView.hidden = false
    let offset = first.nextOffset
    if (offset !== undefined) {
      const more = actionButton('继续读取', () => void run(async () => {
        let next = offset
        while (next !== undefined && rawView.textContent.length < 200_000) {
          const chunk = await call(url('raw-content') + '?' + new URLSearchParams({ path, offset: String(next) }))
          rawView.textContent += chunk.text
          next = chunk.nextOffset
        }
        offset = next
        if (next === undefined) more.remove()
      }), 'ghost small')
      rawView.after(more)
    }
  }

  async function openPage(page, { afterSave = false } = {}) {
    if (!afterSave && state.dirty && !window.confirm('放弃未保存的内容？')) return
    const value = await call(url(`page/${encodeURIComponent(page.pageId)}`))
    state.page = value; state.standard = undefined; state.dirty = false
    editorTitle.textContent = value.relPath
    editor.value = value.content
    saveButton.disabled = true
    return '已打开页面'
  }

  async function openStandard({ afterSave = false } = {}) {
    if (!afterSave && state.dirty && !window.confirm('放弃未保存的内容？')) return
    const value = await call(url('standard'))
    state.page = undefined; state.standard = value; state.dirty = false
    editorTitle.textContent = 'schema.md（文档标准）'
    editor.value = value.content
    saveButton.disabled = true
    return '已打开文档标准'
  }

  async function save() {
    if (!state.page && !state.standard) throw new Error('先选择一个页面或文档标准')
    if (state.page) {
      await call(url(`page/${encodeURIComponent(state.page.pageId)}`), { method: 'PUT', body: { content: editor.value, expectedHash: state.page.sha256 } })
      await openPage(state.page, { afterSave: true })
    } else {
      await call(url('standard'), { method: 'PUT', body: { content: editor.value, expectedHash: state.standard.sha256 } })
      await openStandard({ afterSave: true })
    }
    state.dirty = false; saveButton.disabled = true
    await loadPages()
    return '已写入磁盘'
  }

  async function reload() {
    if (!state.kbId) return '请先创建一个空知识库'
    const config = await refreshConfig()
    const connection = await call(url('connection'))
    if (connection.scope) {
      scopeSelect.value = connection.scope.kind
      projectInput.value = connection.scope.kind === 'project' ? connection.scope.id : ''
    }
    renderConnection(connection)
    if (!config) {
      jobList.replaceChildren(); proposalList.replaceChildren(); rawList.replaceChildren()
      pageList.replaceChildren()
      await Promise.all([loadPython(), loadModels()])
      return '请选择目录并接入知识库'
    }
    await Promise.all([resetPages(), loadJobs(), loadProposals(), resetRaw(), loadPython(), loadModels()])
  }

  const section = (title, note, ...body) => element('section', { class: 'wiki-section' },
    element('h2', {}, title), note ? element('p', { class: 'wiki-section-note' }, note) : null, ...body.filter(Boolean))

  advancedDetails.append(element('div', { class: 'wiki-actions' },
    actionButton('只读检查', () => void run(async () => {
      const items = await call(url('inspect'))
      connectionView.replaceChildren(...items.map(item => element('p', { class: 'wiki-hint' }, item.relPath + ' · ' + (item.error || item.status))))
      return '检查完成；未修改文件'
    }), 'ghost small'),
    actionButton('重建索引', () => void run(async () => { await call(url('rebuild'), { method: 'POST', body: {} }); return '索引已重建' }), 'ghost small'),
    actionButton('恢复中断提交', () => void run(async () => { await call(url('recover'), { method: 'POST', body: {} }); await reload(); return '恢复检查完成' }), 'ghost small')))

  function renderConnection(value) {
    const labels = { unconfigured: '未接入', configured: '目录已保存，尚未接入', ready: '已接入', partial: '部分接入', failed: '接入失败' }
    const connected = ['ready', 'partial'].includes(value.state)
    if (directorySettings) directorySettings.open = !connected
    if (dailySection) dailySection.hidden = !connected
    connectionView.replaceChildren(element('strong', {}, labels[value.state] || '正在检查接入状态'))
    if (value.layout) connectionView.append(element('p', { class: 'wiki-hint' }, '成文目录：' + value.layout.pageDir))
    if (value.report) {
      const report = value.report
      connectionView.append(element('p', { class: 'wiki-hint' }, '本次登记 ' + report.registered + ' 篇 · 已登记 ' + report.existing + ' 篇 · 异常 ' + report.rejected + ' 篇'))
      if (!report.items.length) connectionView.append(element('p', { class: 'wiki-hint' }, '还没有页面，可添加原件后扫描更新。'))
      for (const item of report.items.filter(item => ['invalid', 'too_long'].includes(item.status))) {
        connectionView.append(element('p', { class: 'wiki-error' }, item.relPath + '：' + (item.error || '正文过长，未接入')))
      }
    }
    if (value.error) connectionView.append(element('p', { class: 'wiki-error' }, value.error))
  }

  root.append(
    section('知识库', '', element('div', { class: 'wiki-toolbar' }, baseSelect), connectionView),
    directorySettings = element('details', { class: 'wiki-details wiki-connect-settings' },
      element('summary', {}, '目录与接入设置'),
      connectTitle = element('h2', {}, '接入知识库'),
      element('p', { class: 'wiki-hint' }, '首次接入只登记和索引已有页面，不改原文、不移动原件、不调用模型。'),
      element('div', { class: 'wiki-grid' }, pathField(sourceInput, '原件目录'), pathField(workspaceInput, 'Wiki 工作区')),
      element('p', { class: 'wiki-hint' }, '选择包含 wiki/ 的工作区；正文实际在工作区/wiki，不要重复选择内部的 wiki 文件夹。'),
      element('div', { class: 'wiki-toolbar' }, scopeSelect, projectInput),
      element('p', { class: 'wiki-hint' }, '明确选择本库范围；已有页面的范围不因再次接入而被覆盖。'),
      element('details', { class: 'wiki-details' }, element('summary', {}, '更多设置'),
        pathField(rawInput, 'raw 目录'),
        element('label', { class: 'check-option' }, conversationToggle, element('span', {}, '允许对话证据写入该库'))),
      element('div', { class: 'wiki-actions' },
        actionButton('接入知识库', () => void run(async () => {
          try {
            const result = await call(url('connect'), { method: 'POST', body: {
              sourceDir: sourceInput.value.trim(), workspaceRoot: workspaceInput.value.trim(),
              ...(rawInput.value.trim() ? { rawDir: rawInput.value.trim() } : {}),
              conversationEnabled: conversationToggle.checked, scope: requireProject(),
            } })
            renderConnection(result); await reload()
            return result.state === 'partial' ? '部分接入，请查看异常文件' : '接入完成，可投递原件后扫描更新'
          } catch (error) {
            renderConnection(await call(url('connection')))
            throw error
          }
        }), 'small'),
        actionButton('刷新状态', () => void run(reload), 'ghost small'))),
    dailySection = section('扫描更新', '只扫描原件根目录的新投递文件；已有分类目录不重排。模型只返回结构化候选，由宿主写入文件。',
      element('div', { class: 'wiki-grid' }, pythonSelect, providerSelect, modelSelect),
      pythonNote,
      element('label', { class: 'check-option' }, consentToggle, element('span', {}, '允许把本批资料发送给所选模型', element('small', {}, '分类只看受限预览，蒸馏只看抽取后的正文'))),
      element('div', { class: 'wiki-actions' },
        actionButton('扫描更新', () => void run(async () => {
          const value = requireProject()
          if (!consentToggle.checked) throw new Error('请先确认允许发送资料给模型')
          if (!pythonSelect.value) throw new Error('未检测到 Python，请先安装或在下方手动指定')
          if (!providerSelect.value || !modelSelect.value) throw new Error('请选择模型渠道与模型')
          const result = await call(url('update'), { method: 'POST', body: {
            python: pythonSelect.value, provider: providerSelect.value, model: modelSelect.value, allowModel: true, scope: value,
          } })
          renderConnection(result.connection)
          const job = result.job
          await loadJobs()
          if (result.reused) return `已有任务在运行（${job.id.slice(0, 8)}），未重复扫描，请查看下方进度`
          const { found, duplicates } = job.discovery
          if (!job.items.length) return `页面接入 ${result.connection.report?.registered ?? 0} 篇；原件根目录发现 ${found} 个，跳过 ${duplicates} 个已处理，无新原件待处理（不扫描分类子目录）`
          return `发现 ${found} 个文件，跳过 ${duplicates} 个已处理；任务 ${job.id.slice(0, 8)} 已开始，进度见下方（自动刷新）`
        }), 'small'),
        actionButton('安装缺失依赖', () => void run(async () => {
          if (!pythonSelect.value) throw new Error('未检测到 Python')
          if (!window.confirm('将用该解释器联网安装缺失的解析库（pypdf / xlrd 等）。继续？')) return
          await call(url('python-install'), { method: 'POST', body: { path: pythonSelect.value } })
          await loadPython()
          return '依赖安装完成'
        }), 'ghost small', { hidden: true, 'data-python-install': '1' }),
        actionButton('重新检测 Python', () => void run(async () => { await loadPython(); return '已重新检测' }), 'ghost small'),
        actionButton('刷新任务', () => void run(async () => { await loadJobs(); return '任务状态已刷新' }), 'ghost small')),
      jobList),
    advancedDetails,
    section('蒸馏更新审核', '模型建议替换现有页时先保存候选，批准后才写文件。',
      element('div', { class: 'wiki-actions' }, actionButton('刷新候选', () => void run(loadProposals), 'ghost small')),
      proposalList),
    status)

  if (bases.length) { state.kbId = bases[0].id; baseSelect.value = state.kbId }
  else status.textContent = '还没有知识库，请先在「知识库与挂载」中创建一个空知识库。'
  void run(reload)
  return { root, dispose() { disposed = true; generation++; window.clearTimeout(progressTimer); for (const controller of requestControllers) controller.abort() } }
}
