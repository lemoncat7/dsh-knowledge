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
  const state = { kbId: '', configs: [], pages: [], page: undefined, standard: undefined, dirty: false, runningJobId: '' }
  const status = element('p', { class: 'wiki-status', role: 'status', 'aria-live': 'polite' })
  const activity = element('p', { class: 'wiki-progress', role: 'status', 'aria-live': 'polite' })
  const runBar = element('div', { class: 'wiki-runbar', hidden: true })
  const runText = element('span', {}, '')
  const stopButton = actionButton('停止', () => void run(async () => {
    if (!state.runningJobId) return
    await call(url(`job/${state.runningJobId}`), { method: 'POST', body: { action: 'cancel' } })
    activity.textContent = '已请求停止，正在结束当前文件…'
    await loadJobs()
  }), 'danger small')
  runBar.append(runText, stopButton)
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
  const sourceInput = element('input', { class: 'input', placeholder: '源文件夹（新原件放在这里）', 'aria-label': '源文件夹' })
  const workspaceInput = element('input', { class: 'input', placeholder: 'Wiki 成文文件夹（直接选择 wiki）', 'aria-label': 'Wiki 文件夹' })
  const rawInput = element('input', { class: 'input', placeholder: '留空则使用工作区/raw', 'aria-label': 'raw 目录' })
  const conversationToggle = element('input', { type: 'checkbox' })
  // Scope remains a backend compatibility policy, not a manual setup task.
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
  const previewNote = element('p', { class: 'wiki-hint' })
  const previewList = element('div', { class: 'wiki-list' })
  let processButton
  let previewCount = 0
  // Source-change overview: the host runs the periodic comparison, so this view only shows the last result.
  const CHANGE_EXAMPLES = 3
  const changeHead = element('div', { class: 'wiki-row wiki-change-head' })
  const changeBadge = badge('检查中…')
  changeHead.append(element('h2', {}, '资料变化'), changeBadge)
  const changeNote = element('p', { class: 'wiki-section-note' })
  const changeStamp = element('p', { class: 'wiki-hint' })
  const changeList = element('div', { class: 'wiki-list wiki-changes' })
  let reviewButton
  const changeSection = element('section', { class: 'wiki-section wiki-change-section' },
    changeHead, changeNote, changeStamp, changeList,
    element('div', { class: 'wiki-actions' },
      actionButton('立即检查', () => void run(inspectChangesNow), 'small'),
      reviewButton = actionButton('查看并处理', () => void run(previewChanges), 'ghost small', { hidden: true })))
  changeSection.hidden = true
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
  editor.addEventListener('input', () => { state.dirty = true; saveButton.disabled = false })
  consentToggle.addEventListener('change', () => { if (processButton) processButton.disabled = !consentToggle.checked || !previewCount })
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
    catch (error) { status.textContent = error.message; activity.textContent = error.message }
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
    workspaceInput.value = current?.layout.pageDir ?? ''
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
    if (current) parts.push(`当前：${current.source.split(/[\\/]/).pop()}（${current.activity || STAGE_LABEL[current.stage] || current.stage}）`)
    return parts.join(' · ')
  }

  function drawJobs(jobs) {
    const active = jobs.find(job => job.state === 'running')
    state.runningJobId = active?.id ?? ''
    runBar.hidden = !active
    if (active) runText.textContent = `处理中：${stageSummary(active)}`
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
        if (item.stage === 'done' && item.registered) row.append(element('small', { class: 'wiki-hint' }, '已登记（原位，不搬运）：该类型不抽取、不生成知识页'))
        else if (item.stage === 'done' && !item.pages?.length) row.append(element('small', { class: 'wiki-hint' }, '已记录处理结果，未生成知识页'))
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
    if (config && connection.state === 'configured' && config.layout.workspaceRoot.split(/[\\/]/).pop()?.toLowerCase() === 'wiki') workspaceInput.value = config.layout.workspaceRoot
    renderConnection(connection)
    if (!config) {
      jobList.replaceChildren(); proposalList.replaceChildren(); rawList.replaceChildren()
      pageList.replaceChildren()
      await Promise.all([loadPython(), loadModels()])
      return '请选择目录并接入知识库'
    }
    await Promise.all([resetPages(), loadJobs(), loadProposals(), resetRaw(), loadPython(), loadModels(), loadChanges({ quiet: true })])
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

  const unreadable = item => ['invalid', 'too_long'].includes(item.status)
  // Mirrors src/wiki/diagnostics.ts for reports stored before the host kept a readable reason.
  const REJECTION_REASONS = {
    INVALID_MARKDOWN: 'front matter 解析失败，读不出标题与来源',
    UNKNOWN_SCOPE: 'scope 字段不是受支持的 global / project 结构',
    UNKNOWN_PROVENANCE: 'provenance 字段不在允许取值内',
    INVALID_ARGUMENT: 'front matter 取值不合法（status 只能是 active / archived）',
    WIKI_PAGE_BODY_EMPTY: '页面正文为空',
    WIKI_PAGE_BODY_TOO_LONG: '正文超过 50000 字符',
    PATH_ESCAPE: '页面路径指向 Wiki 文件夹之外（可能是符号链接）',
    RESERVED_PATH: '页面路径命中保留名或非法字符',
  }
  const REJECTION_SUFFIX = '，因此未登记、不可检索；原文件未被改写'
  /**
   * Stored reports keep the failing class in three shapes: `CODE：…`, `CODE: …` and a stringified
   * `Error: CODE`. All three resolve to one code so a bare class still gets a readable reason.
   */
  function rejectionCode(item) {
    if (item.errorCode) return item.errorCode
    const match = /^(?:Error:\s*)?([A-Z][A-Z0-9_]{2,})(?=[：:]|\s*$)/.exec(String(item.error ?? '').trim())
    return match?.[1] ?? 'WIKI_PAGE_UNREADABLE'
  }
  /** The code is shown on its own, so the stored prefix is dropped before the reason is displayed. */
  function pageReason(item, code) {
    if (item.errorReason) return item.errorReason
    const detail = String(item.error ?? '')
      .replace(/^Error:\s*/, '')
      .replace(new RegExp('^' + code + '\\s*[:：]?\\s*'), '')
      .trim()
    const base = REJECTION_REASONS[code]
    if (!base) return detail || '页面无法读取或解析'
    if (!detail) return base + REJECTION_SUFFIX
    return (/\p{Script=Han}/u.test(detail) ? detail : `${base}（${detail}）`) + REJECTION_SUFFIX
  }
  /**
   * Old stored reports only carried a prose error per page, so recover the code from the message
   * prefix and group them the same way the current report does.
   */
  function issueGroups(report) {
    const rejected = (report.items ?? []).filter(unreadable)
    if (report.issues?.length) return { rejected, issues: report.issues }
    const groups = new Map()
    for (const item of rejected) {
      const code = rejectionCode(item)
      const group = groups.get(code) ?? { code, reason: pageReason(item, code), count: 0, examples: [] }
      group.count += 1
      if (group.examples.length < 3) group.examples.push(item.relPath)
      groups.set(code, group)
    }
    return { rejected, issues: [...groups.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)) }
  }

  /** A count alone explains nothing: state the meaning, group the reasons, show real paths and the way out. */
  function renderRejections(report) {
    const { rejected, issues } = issueGroups(report)
    if (!report.rejected || !rejected.length) return
    const block = element('div', { class: 'wiki-explain', role: 'group', 'aria-label': '异常页面说明' })
    block.append(element('p', { class: 'wiki-explain-title' }, `异常 ${report.rejected} 篇是什么意思`))
    block.append(element('p', { class: 'wiki-hint' },
      '这些页面没有登记进 Wiki 索引，所以也搜不到。最常见的原因是正文开头的 front matter（--- 之间的元数据）无法解析，'
      + '读不出标题与来源；正文超过 5 万字符同样会被拒绝。页面文件本身没有被修改，仍原样留在 wiki 文件夹里。'))
    const list = element('ul', { class: 'wiki-issues' })
    for (const issue of issues) {
      const row = element('li', { class: 'wiki-issue' },
        element('span', { class: 'wiki-issue-count' }, `${issue.count} 篇`),
        element('span', { class: 'wiki-issue-code' }, issue.code),
        element('span', { class: 'wiki-issue-reason' }, issue.reason))
      if (issue.examples?.length) row.append(element('small', { class: 'wiki-issue-examples' }, '示例：' + issue.examples.join('、')))
      list.append(row)
    }
    block.append(list)
    block.append(element('p', { class: 'wiki-hint' },
      '怎么处理：把这些页面 front matter 里含冒号或反斜杠的取值加上引号，修好后点「刷新状态」或重新接入一次即可登记；'
      + '在修好之前，其余页面照常可搜可用。'))
    const details = element('details', { class: 'wiki-details wiki-rejection-list' },
      element('summary', {}, `查看异常清单（${rejected.length} 条）`))
    for (const item of rejected.slice(0, 200)) {
      details.append(element('div', { class: 'wiki-row wiki-row-detail' },
        element('span', { class: 'wiki-path', title: item.relPath }, item.relPath),
        item.metadataRepair ? badge('需修复元数据', 'warning') : null,
        element('small', { class: 'wiki-error' }, pageReason(item, rejectionCode(item)))))
    }
    if (rejected.length > 200) details.append(element('p', { class: 'wiki-hint' }, `还有 ${rejected.length - 200} 条未列出。`))
    block.append(details)
    connectionView.append(block)
  }

  function formatStamp(value) {
    const date = new Date(value ?? '')
    if (Number.isNaN(date.getTime())) return String(value ?? '')
    const pad = number => String(number).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  function setChangeBadge(label, variant = '') {
    changeBadge.setAttribute('class', ('badge ' + variant).trim())
    changeBadge.textContent = label
  }

  /** One class of change: its count, why it matters and a few real paths. It never owns an action of its own. */
  function changeGroup(kind, label, entries) {
    const group = element('div', { class: 'wiki-change-group' },
      element('p', { class: 'wiki-change-title' }, `${label} ${entries.length} 个`))
    if (kind === 'changed') group.append(element('p', { class: 'wiki-hint' }, '这些原件在归档后被修改过；扫描不会重排已归档的分类目录，如需重新入库，请把原件放回源文件夹根层或新建的投递文件夹。'))
    if (kind === 'missing') group.append(element('p', { class: 'wiki-hint' }, '源文件已不存在，知识库内容不会自动删除；把原件放回原处即可消除这条提示。'))
    if (kind === 'skipped') group.append(element('p', { class: 'wiki-hint' }, '这些文件因大小或类型无法抽取，已被跳过；可拆分或转换后重新投递。'))
    for (const entry of entries.slice(0, CHANGE_EXAMPLES)) {
      group.append(element('div', { class: 'wiki-row wiki-row-detail' },
        element('span', { class: 'wiki-path', title: entry.relPath }, entry.relPath),
        entry.folder ? badge('文件夹投递 · ' + entry.folder, 'accent') : null,
        kind === 'skipped'
          ? element('span', { class: 'muted' }, entry.reason ?? '未处理')
          : (kind !== 'missing' && entry.size ? element('span', { class: 'muted' }, Math.round(entry.size / 1024) + ' KB') : null)))
    }
    if (entries.length > CHANGE_EXAMPLES) group.append(element('p', { class: 'wiki-hint' }, `还有 ${entries.length - CHANGE_EXAMPLES} 个未列出。`))
    return group
  }

  function renderChanges(report) {
    changeList.replaceChildren()
    reviewButton.hidden = true
    if (!report) {
      setChangeBadge('待检查')
      changeNote.textContent = '后台会定时核对源文件夹与已归档原件；本区只读，只显示最新结果，不会移动或删除文件。'
      changeStamp.textContent = '还没有检查记录。点「立即检查」核对一次，或等后台定时检查。'
      return
    }
    const fresh = report.new ?? [], changed = report.changed ?? [], missing = report.missing ?? []
    // `skipped` is the list of files the scan could not process; `skippedRound` means nothing was looked at.
    const skippedFiles = Array.isArray(report.skipped) ? report.skipped : []
    const skippedRound = report.skippedRound === true
    const baseNote = skippedRound
      ? '有处理任务在运行，本次检查被跳过；下面仍是上一次完整的结果。'
      : '后台会定时核对源文件夹与已归档原件；本区只读，只显示最新结果，不会移动或删除文件。'
    // Unprocessed material must survive next to the change counts, never behind a "clean" badge.
    changeNote.textContent = skippedFiles.length ? `${baseNote}另有 ${skippedFiles.length} 项因过大未处理（见下）。` : baseNote
    changeStamp.textContent = `上次检查：${formatStamp(report.scannedAt)}`
    const pending = fresh.length + changed.length
    const badgeParts = []
    if (pending) badgeParts.push(`${pending} 项待处理`)
    if (missing.length) badgeParts.push(`${missing.length} 项缺失`)
    if (skippedFiles.length) badgeParts.push(`另有 ${skippedFiles.length} 项因过大未处理`)
    if (badgeParts.length) setChangeBadge(badgeParts.join(' · '), pending || skippedFiles.length ? 'warning' : '')
    else if (skippedRound) setChangeBadge('已跳过')
    else setChangeBadge('无变化', 'success')
    if (fresh.length) changeList.append(changeGroup('new', '新增', fresh))
    if (changed.length) changeList.append(changeGroup('changed', '变更', changed))
    if (missing.length) changeList.append(changeGroup('missing', '缺失', missing))
    if (skippedFiles.length) changeList.append(changeGroup('skipped', '因过大未处理', skippedFiles))
    // A skipped round never looked at the source tree; skipped files mean there is still unprocessed material.
    if (!pending && !missing.length) changeList.append(element('p', { class: 'wiki-hint' },
      skippedRound ? '本次检查被跳过，暂无新的结果。'
        : skippedFiles.length ? `没有新增或变更，但另有 ${skippedFiles.length} 项因过大未处理，不能算完全干净。`
          : '未发现资料变化。'))
    reviewButton.hidden = pending === 0
  }

  /** Opening the page reads the last stored result; only an explicit click starts a new comparison. */
  async function loadChanges({ quiet = false } = {}) {
    try {
      const report = await call(url('changes'))
      renderChanges(report)
      return report
    } catch (error) {
      if (!quiet) throw error
      setChangeBadge('未知')
      changeStamp.textContent = '暂时读不到资料变化：' + error.message
      return null
    }
  }

  async function inspectChangesNow() {
    const report = await call(url('changes'), { method: 'POST', body: {} })
    renderChanges(report)
    if (report?.skippedRound) return '有任务在处理，本次检查已跳过'
    const pending = (report?.new ?? []).length + (report?.changed ?? []).length
    const skipped = Array.isArray(report?.skipped) ? report.skipped.length : 0
    if (pending) return `检查完成：${pending} 项待处理${skipped ? `，另有 ${skipped} 项因过大未处理` : ''}；未修改任何文件`
    if (skipped) return `检查完成：另有 ${skipped} 项因过大未处理；未修改任何文件`
    return '检查完成：未发现资料变化'
  }

  /** This entry only opens the existing two-step preview; starting the job stays a separate confirmation. */
  async function previewChanges() {
    const message = await startScan()
    return `${message}；请在下方「扫描预览」核对，确认后再点「开始处理」`
  }

  /**
   * Preview separates root-level files from folder deliveries so both kinds are visible.
   * Files that are deliberately not processed (too large to extract) get their own explained block.
   * Nothing is moved here: the confirmed processing step still does all the work.
   */
  function renderScanPreview(files, folders, skipped) {
    const blocked = skipped ?? []
    const fresh = files.filter(file => !file.duplicate)
    const rootFiles = fresh.filter(file => !file.folder)
    const groups = new Map()
    for (const file of files) {
      if (!file.folder) continue
      const group = groups.get(file.folder) ?? { name: file.folder, total: 0, pending: [] }
      group.total += 1
      if (!file.duplicate) group.pending.push(file)
      groups.set(file.folder, group)
    }
    // A declared folder with only already-processed files still deserves its name in the preview.
    for (const entry of folders ?? []) if (!groups.has(entry.name)) groups.set(entry.name, { name: entry.name, total: entry.count, pending: [] })
    const listed = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
    previewList.replaceChildren()
    if (rootFiles.length) {
      previewList.append(element('p', { class: 'wiki-preview-group' }, `根层文件（${rootFiles.length} 个待处理）`))
      for (const file of rootFiles) {
        previewList.append(element('div', { class: 'wiki-row' },
          element('span', {}, file.name), element('span', { class: 'muted' }, Math.round(file.size / 1024) + ' KB')))
      }
    }
    if (listed.length) {
      const pending = listed.reduce((sum, group) => sum + group.pending.length, 0)
      previewList.append(element('p', { class: 'wiki-preview-group' }, `文件夹投递（${listed.length} 个文件夹，${pending} 个待处理）`))
      for (const group of listed) {
        previewList.append(element('div', { class: 'wiki-row wiki-folder-row' },
          element('strong', { class: 'wiki-folder-name' }, group.name),
          badge(group.pending.length ? `${group.pending.length} 个待处理` : '已全部处理', group.pending.length ? 'accent' : ''),
          element('span', { class: 'muted' }, `共 ${group.total} 个文件`)))
        for (const file of group.pending) previewList.append(element('div', { class: 'wiki-row wiki-row-detail' },
          element('span', { class: 'wiki-path', title: file.relPath ?? file.name }, file.relPath ?? file.name),
          element('span', { class: 'muted' }, Math.round(file.size / 1024) + ' KB')))
      }
    }
    if (blocked.length) {
      // Skipping is never silent: every file that will not be processed says why.
      previewList.append(element('p', { class: 'wiki-preview-group' }, `因过大未处理（${blocked.length} 个文件）`))
      for (const file of blocked) previewList.append(element('div', { class: 'wiki-row wiki-row-detail' },
        element('span', { class: 'wiki-path', title: file.relPath ?? file.name }, file.relPath ?? file.name),
        element('span', { class: 'muted' }, `${Math.round(file.size / 1024 / 1024)} MB · ${file.reason ?? '未处理'}`)))
    }
    return {
      fresh, rootPending: rootFiles.length,
      folderPending: listed.reduce((sum, group) => sum + group.pending.length, 0),
      folderCount: listed.filter(group => group.pending.length).length,
      blocked: blocked.length,
    }
  }

  function scanSummary(totals) {
    const parts = []
    if (totals.rootPending) parts.push(`根层文件 ${totals.rootPending} 个`)
    if (totals.folderPending) parts.push(`文件夹投递 ${totals.folderPending} 个，来自 ${totals.folderCount} 个文件夹`)
    const blocked = totals.blocked ? `；另有 ${totals.blocked} 个文件因过大未处理（见下方说明）` : ''
    return `发现 ${totals.fresh.length} 个待处理原件：${parts.join('；')}（跳过 ${totals.skipped} 个已处理）${blocked}。确认后：可抽取资料移动到分类目录并调用模型；只登记类型只写回执、原件原地保留。`
  }

  /** One read-only scan preview shared by the scan button and the source-change entry point. */
  async function startScan() {
    activity.textContent = '正在检查目录与已有页面，只读取，不移动文件…'
    const result = await call(url('scan'), { method: 'POST', body: {} })
    renderConnection(result.connection)
    const total = renderScanPreview(result.files, result.folders, result.skipped)
    const totals = { ...total, skipped: result.files.length - total.fresh.length }
    previewNote.textContent = total.fresh.length
      ? scanSummary(totals)
      : total.blocked
        ? `没有待处理原件（跳过 ${totals.skipped} 个已处理）；另有 ${total.blocked} 个文件因过大未处理（见下方说明）。根层文件与根层文件夹都会扫描，已归档的分类目录不重复处理。`
        : `没有待处理原件（跳过 ${totals.skipped} 个已处理）。根层文件与根层文件夹都会扫描，已归档的分类目录不重复处理。`
    previewCount = total.fresh.length
    processButton.disabled = !total.fresh.length || !consentToggle.checked
    processButton.hidden = !total.fresh.length
    await loadJobs()
    return total.fresh.length ? `发现 ${total.fresh.length} 个原件，等待你确认处理` : '没有待处理原件'
  }

  function renderConnection(value) {
    const labels = { unconfigured: '未接入', configured: '目录已保存，尚未接入', ready: '已接入', partial: '部分接入', failed: '接入失败' }
    const connected = ['ready', 'partial'].includes(value.state)
    if (directorySettings) directorySettings.open = !connected
    if (dailySection) dailySection.hidden = !connected
    changeSection.hidden = !connected
    connectionView.replaceChildren(element('strong', {}, labels[value.state] || '正在检查接入状态'))
    if (value.layout) connectionView.append(element('p', { class: 'wiki-hint' }, '成文目录：' + value.layout.pageDir))
    if (value.report) {
      const report = value.report
      const summary = ['本次登记 ' + report.registered + ' 篇', '已登记 ' + report.existing + ' 篇']
      // Repaired pages are readable through the restricted rule, but the manifest still flags them.
      if (report.repaired) summary.push('需修复元数据 ' + report.repaired + ' 篇')
      if (report.rejected) summary.push('异常 ' + report.rejected + ' 篇（未登记、不可检索）')
      connectionView.append(element('p', { class: 'wiki-hint' }, summary.join(' · ')))
      if (report.repaired) connectionView.append(element('p', { class: 'wiki-hint' },
        report.repaired + ' 篇旧页已按受限规则读取，并在清单里标记「需修复元数据」；文件未改动。'))
      if (!(report.items ?? []).length) connectionView.append(element('p', { class: 'wiki-hint' }, '还没有页面，可添加原件后扫描更新。'))
      renderRejections(report)
    }
    if (value.error) connectionView.append(element('p', { class: 'wiki-error' }, value.error))
  }

  root.append(
    section('知识库', '', element('div', { class: 'wiki-toolbar' }, baseSelect), connectionView),
    directorySettings = element('details', { class: 'wiki-details wiki-connect-settings' },
      element('summary', {}, '目录与接入设置'),
      connectTitle = element('h2', {}, '接入知识库'),
      element('p', { class: 'wiki-hint' }, '首次接入只登记和索引已有页面，不改原文、不移动原件、不调用模型。'),
      element('div', { class: 'wiki-grid' }, pathField(sourceInput, '源文件夹'), pathField(workspaceInput, 'Wiki 文件夹'), pathField(rawInput, 'raw 文件夹')),
      element('p', { class: 'wiki-hint' }, '直接选择存放成文的 wiki 文件夹；不会再追加一层 wiki。新库按普通知识库使用，已有页面范围保持不变。'),
      element('details', { class: 'wiki-details' }, element('summary', {}, '更多设置'),
        element('label', { class: 'check-option' }, conversationToggle, element('span', {}, '允许对话证据写入该库'))),
      element('div', { class: 'wiki-actions' },
        actionButton('接入知识库', () => void run(async () => {
          try {
            const result = await call(url('connect'), { method: 'POST', body: {
              sourceDir: sourceInput.value.trim(), wikiDir: workspaceInput.value.trim(),
              ...(rawInput.value.trim() ? { rawDir: rawInput.value.trim() } : {}),
              conversationEnabled: conversationToggle.checked,
            } })
            renderConnection(result); await reload()
            return result.state === 'partial' ? '部分接入，请查看异常文件' : '接入完成，可投递原件后扫描更新'
          } catch (error) {
            renderConnection(await call(url('connection')))
            throw error
          }
        }), 'small'),
        actionButton('刷新状态', () => void run(reload), 'ghost small'))),
    changeSection,
    dailySection = section('扫描更新', '根层文件与根层新增文件夹里的资料都会扫描；已归档的分类目录不重复处理。模型只返回结构化候选，由宿主写入文件。',
      element('div', { class: 'wiki-grid' }, pythonSelect, providerSelect, modelSelect),
      pythonNote,
      element('label', { class: 'check-option' }, consentToggle, element('span', {}, '允许把本批资料发送给所选模型', element('small', {}, '分类只看受限预览，蒸馏只看抽取后的正文'))),
      element('div', { class: 'wiki-actions' },
        actionButton('扫描更新', () => void run(startScan), 'small'),
        processButton = actionButton('开始处理', () => void run(async () => {
          if (!consentToggle.checked) throw new Error('请先确认允许发送资料给模型')
          if (!pythonSelect.value) throw new Error('未检测到 Python，请先安装或重新检测')
          if (!providerSelect.value || !modelSelect.value) throw new Error('请选择模型渠道与模型')
          if (!window.confirm('将处理待处理原件：可抽取资料移动到分类子目录并调用所选模型抽取与蒸馏；只登记类型（视频/安装包等）只写回执、原件原地保留。继续？')) return
          activity.textContent = '正在启动处理任务…'
          const job = await call(url('process'), { method: 'POST', body: {
            python: pythonSelect.value, provider: providerSelect.value, model: modelSelect.value, allowModel: true,
          } })
          await loadJobs()
          return `已开始处理 ${job.items.length} 个文件，可在上方停止`
        }), 'small', { disabled: true, hidden: true }),
        actionButton('安装缺失依赖', () => void run(async () => {
          if (!pythonSelect.value) throw new Error('未检测到 Python')
          if (!window.confirm('将用该解释器联网安装缺失的解析库（pypdf / xlrd 等）。继续？')) return
          await call(url('python-install'), { method: 'POST', body: { path: pythonSelect.value } })
          await loadPython()
          return '依赖安装完成'
        }), 'ghost small', { hidden: true, 'data-python-install': '1' }),
        actionButton('重新检测 Python', () => void run(async () => { await loadPython(); return '已重新检测' }), 'ghost small'),
        actionButton('刷新任务', () => void run(async () => { await loadJobs(); return '任务状态已刷新' }), 'ghost small')),
      runBar, activity, previewNote, previewList, jobList),
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
