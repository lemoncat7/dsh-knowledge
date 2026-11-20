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
  const rawList = element('div', { class: 'wiki-list' })
  const rawView = element('pre', { class: 'wiki-pre', hidden: true })
  const editor = element('textarea', { class: 'textarea wiki-editor', rows: 22, spellcheck: 'false', 'aria-label': 'Markdown 编辑器' })
  const editorTitle = element('strong', { class: 'wiki-editor-title' }, '未选择文件')
  const saveButton = actionButton('保存当前文件', () => void run(save), 'small')
  saveButton.disabled = true

  const url = suffix => `wiki/${encodeURIComponent(state.kbId)}/${suffix}`
  const scope = () => scopeSelect.value === 'global' ? { kind: 'global' } : { kind: 'project', id: projectInput.value.trim() }
  const requireProject = () => {
    if (scopeSelect.value === 'project' && !projectInput.value.trim()) throw new Error('请先填写项目范围')
    return scope()
  }

  editor.addEventListener('input', () => { state.dirty = true; saveButton.disabled = false })
  baseSelect.addEventListener('change', () => {
    const next = baseSelect.value
    if (busy || (state.dirty && !window.confirm('放弃未保存的内容并切换知识库？'))) {
      baseSelect.value = state.kbId
      return
    }
    state.kbId = next
    state.page = undefined; state.standard = undefined; state.dirty = false; state.pages = []
    editor.value = ''; editorTitle.textContent = '未选择文件'; saveButton.disabled = true
    rawView.textContent = ''; rawView.hidden = true
    consentToggle.checked = false
    void run(reload)
  })

  async function run(action) {
    if (busy) return
    busy = true; baseSelect.disabled = true; root.setAttribute('aria-busy', 'true'); status.textContent = '处理中…'
    try { status.textContent = (await action()) ?? '已完成' }
    catch (error) { status.textContent = error.message }
    finally { busy = false; baseSelect.disabled = false; root.removeAttribute('aria-busy') }
  }

  function browse(input, label) {
    return createWikiDirectoryBrowser({ api, endpoint: url("browse"), element, actionButton, interfaceIcon, openModal,
      initial: input.value.trim(), label,
      onSelect: path => { input.value = path; input.dispatchEvent(new Event("input", { bubbles: true })); status.textContent = "已选择 " + path },
    })
  }

  /** Native Windows dialog first; the in-console browser is only the fallback. */
  async function chooseDirectory(input, label) {
    try {
      const result = await api(url('pick'), { method: 'POST', body: { ...(input.value.trim() ? { initial: input.value.trim() } : {}) } })
      if (result?.path) { input.value = result.path; return '已选择 ' + result.path }
      return '已取消选择'
    } catch (error) {
      if (/PICK_CANCELLED/.test(error.message)) return '已取消选择'
      browse(input, label)
      return error.message + '；已改为站内浏览'
    }
  }

  const pathField = (input, label) => element('div', { class: 'wiki-path-field' },
    input,
    actionButton('选择目录…', () => void run(() => chooseDirectory(input, label)), 'ghost small', { 'aria-label': `选择${label}` }),
    actionButton('站内浏览', () => browse(input, label), 'ghost small'))

  async function refreshConfig() {
    state.configs = await api('wiki')
    const current = state.configs.find(entry => entry.kbId === state.kbId)
    sourceInput.value = current?.layout.sourceDir ?? ''
    workspaceInput.value = current?.layout.workspaceRoot ?? ''
    rawInput.value = current?.layout.rawDir ?? ''
    conversationToggle.checked = Boolean(current?.conversationEnabled)
    return current
  }

  async function loadPython() {
    const data = await api(url('python'))
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
    const data = await api(url('models'))
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

  async function loadPages() {
    pageList.replaceChildren()
    if (!state.configs.some(entry => entry.kbId === state.kbId)) {
      pageList.append(element('p', { class: 'muted' }, '该知识库还没有绑定 Wiki 目录。保存配置后可登记已有页面。'))
      return
    }
    state.pages = await api(url('pages'))
    if (!state.pages.length) { pageList.append(element('p', { class: 'muted' }, '还没有登记任何页面。')); return }
    for (const page of state.pages) {
      pageList.append(element('div', { class: 'wiki-row' },
        actionButton(page.relPath, () => void run(() => openPage(page)), 'ghost small'),
        badge(page.status === 'active' ? '使用中' : '已归档', page.status === 'active' ? 'success' : ''),
        element('span', { class: 'muted' }, `${page.provenance?.kind ?? 'unknown'} · v${page.version}`)))
    }
  }

  async function loadJobs() {
    jobList.replaceChildren()
    const jobs = await api(url('jobs'))
    if (!jobs.length) { jobList.append(element('p', { class: 'muted' }, '还没有入库任务。')); return }
    for (const job of jobs) {
      const head = element('div', { class: 'wiki-row' },
        element('strong', {}, `任务 ${job.id.slice(0, 8)}`),
        badge(STATUS_LABEL[job.state] ?? job.state, job.state === 'done' ? 'success' : job.state === 'failed' ? 'danger' : ''),
        element('span', { class: 'muted' }, `${job.items.filter(item => item.stage === 'done').length}/${job.items.length} 完成`),
        actionButton('刷新', () => void run(loadJobs), 'ghost small'),
        actionButton('续跑', () => void run(async () => { await api(url(`job/${job.id}`), { method: 'POST', body: { action: 'resume' } }); await loadJobs() }), 'ghost small'),
        actionButton('取消', () => void run(async () => { await api(url(`job/${job.id}`), { method: 'POST', body: { action: 'cancel' } }); await loadJobs() }), 'ghost small'))
      const detail = element('div', { class: 'wiki-job-items' })
      for (const item of job.items) {
        const row = element('div', { class: 'wiki-row wiki-row-detail' },
          element('span', { class: 'wiki-path', title: item.source }, item.source.split(/[\\/]/).pop()),
          badge(STAGE_LABEL[item.stage] ?? item.stage, item.stage === 'failed' ? 'danger' : item.stage === 'review' ? 'warning' : ''),
          item.error ? element('small', { class: 'wiki-error' }, item.error) : null)
        if (item.stage === 'review') {
          row.append(actionButton('指定分类', () => void run(async () => {
            const category = window.prompt('输入分类文件夹名')
            if (!category) return
            await api(url(`job/${job.id}`), { method: 'POST', body: { action: 'classify', itemId: item.id, category } })
            await loadJobs()
          }), 'ghost small'))
        }
        detail.append(row)
      }
      jobList.append(element('div', { class: 'wiki-card' }, head, detail))
    }
  }

  async function loadProposals() {
    proposalList.replaceChildren()
    const values = await api(url('proposals'))
    if (!values.length) { proposalList.append(element('p', { class: 'muted' }, '没有待审核的旧页更新。')); return }
    for (const proposal of values) {
      const card = element('div', { class: 'wiki-card' }, element('details', { class: 'wiki-details' },
        element('summary', {}, `${proposal.pageId.slice(0, 8)} · ${proposal.state === 'pending' ? '待审核' : proposal.state === 'approved' ? '已批准' : '已拒绝'}`),
        element('pre', { class: 'wiki-pre' }, proposal.content)))
      if (proposal.state === 'pending') {
        card.append(element('div', { class: 'wiki-actions' },
          actionButton('批准替换', () => void run(async () => { await api(url(`proposal/${proposal.id}`), { method: 'POST', body: { approve: true } }); await loadProposals() }), 'small'),
          actionButton('拒绝', () => void run(async () => { await api(url(`proposal/${proposal.id}`), { method: 'POST', body: { approve: false } }); await loadProposals() }), 'ghost small')))
      }
      proposalList.append(card)
    }
  }

  async function loadRaw() {
    rawList.replaceChildren(); rawView.hidden = true
    const entries = await api(url('raw'))
    if (!entries.length) { rawList.append(element('p', { class: 'muted' }, 'raw 目录为空。')); return }
    for (const entry of entries) {
      rawList.append(element('div', { class: 'wiki-row' },
        actionButton(entry.path, () => void run(() => showRaw(entry.path)), 'ghost small'),
        element('span', { class: 'muted' }, `${Math.round(entry.bytes / 1024)} KB`)))
    }
  }

  async function showRaw(path) {
    const first = await api(url('raw-content') + '?' + new URLSearchParams({ path, offset: '0' }))
    rawView.textContent = first.text
    rawView.hidden = false
    let offset = first.nextOffset
    if (offset !== undefined) {
      const more = actionButton('继续读取', () => void run(async () => {
        let next = offset
        while (next !== undefined && rawView.textContent.length < 200_000) {
          const chunk = await api(url('raw-content') + '?' + new URLSearchParams({ path, offset: String(next) }))
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
    const value = await api(url(`page/${encodeURIComponent(page.pageId)}`))
    state.page = value; state.standard = undefined; state.dirty = false
    editorTitle.textContent = value.relPath
    editor.value = value.content
    saveButton.disabled = true
    return '已打开页面'
  }

  async function openStandard({ afterSave = false } = {}) {
    if (!afterSave && state.dirty && !window.confirm('放弃未保存的内容？')) return
    const value = await api(url('standard'))
    state.page = undefined; state.standard = value; state.dirty = false
    editorTitle.textContent = 'schema.md（文档标准）'
    editor.value = value.content
    saveButton.disabled = true
    return '已打开文档标准'
  }

  async function save() {
    if (!state.page && !state.standard) throw new Error('先选择一个页面或文档标准')
    if (state.page) {
      await api(url(`page/${encodeURIComponent(state.page.pageId)}`), { method: 'PUT', body: { content: editor.value, expectedHash: state.page.sha256 } })
      await openPage(state.page, { afterSave: true })
    } else {
      await api(url('standard'), { method: 'PUT', body: { content: editor.value, expectedHash: state.standard.sha256 } })
      await openStandard({ afterSave: true })
    }
    state.dirty = false; saveButton.disabled = true
    await loadPages()
    return '已写入磁盘'
  }

  async function reload() {
    if (!state.kbId) return '请先创建一个空知识库'
    const config = await refreshConfig()
    if (!config) {
      jobList.replaceChildren(); proposalList.replaceChildren(); rawList.replaceChildren()
      await Promise.all([loadPages(), loadPython(), loadModels()])
      return '请先选择目录并保存库配置'
    }
    await Promise.all([loadPages(), loadJobs(), loadProposals(), loadRaw(), loadPython(), loadModels()])
  }

  const section = (title, note, ...body) => element('section', { class: 'wiki-section' },
    element('h2', {}, title), note ? element('p', { class: 'wiki-section-note' }, note) : null, ...body.filter(Boolean))

  root.append(
    section('库与目录', '文件是成文权威，raw 只读。目录必须是已存在的绝对路径，且不能与其他库重叠。',
      element('div', { class: 'wiki-toolbar' }, baseSelect),
      element('div', { class: 'wiki-grid' }, pathField(sourceInput, '原件目录'), pathField(workspaceInput, '工作区目录'), pathField(rawInput, 'raw 目录')),
      element('label', { class: 'check-option' }, conversationToggle, element('span', {}, '允许对话证据写入该库', element('small', {}, '默认关闭；开启后批准的对话候选才会落地为文件'))),
      element('div', { class: 'wiki-actions' },
        actionButton('保存库配置', () => void run(async () => {
          await api(`wiki/${encodeURIComponent(state.kbId)}`, { method: 'PUT', body: {
            sourceDir: sourceInput.value.trim(), workspaceRoot: workspaceInput.value.trim(),
            ...(rawInput.value.trim() ? { rawDir: rawInput.value.trim() } : {}), conversationEnabled: conversationToggle.checked,
          } })
          await reload(); return '库配置已保存'
        }), 'small'),
        actionButton('刷新', () => void run(reload), 'ghost small'))),
    section('存量接管', '先只读对账，确认无误后再登记。登记只新增身份与索引，不改写旧 Markdown。',
      element('div', { class: 'wiki-toolbar' }, scopeSelect, projectInput),
      element('div', { class: 'wiki-actions' },
        actionButton('只读对账', () => void run(async () => {
          const report = await api(url('inspect'))
          const counts = report.reduce((accumulator, item) => { accumulator[item.status] = (accumulator[item.status] ?? 0) + 1; return accumulator }, {})
          return `对账完成：${Object.entries(counts).map(([key, value]) => `${key} ${value}`).join('，')}`
        }), 'small'),
        actionButton('登记已有 Wiki', () => void run(async () => {
          const value = requireProject()
          if (!window.confirm('将登记现有页面身份与权限，不改写原文。继续？')) return
          await api(url('import'), { method: 'POST', body: { scope: value, dryRun: false } })
          await reload(); return '登记完成'
        }), 'small'),
        actionButton('刷新索引', () => void run(async () => { await api(url('rebuild'), { method: 'POST', body: {} }); await reload(); return '索引已重建' }), 'ghost small'),
        actionButton('恢复中断提交', () => void run(async () => { const result = await api(url('recover'), { method: 'POST', body: {} }); return `恢复 ${result.length} 条提交` }), 'ghost small'))),
    section('扫描并入库', '只扫描原件根目录的新投递文件；已有分类目录不重排。模型只返回结构化候选，由宿主写入文件。',
      element('div', { class: 'wiki-grid' }, pythonSelect, providerSelect, modelSelect),
      pythonNote,
      element('label', { class: 'check-option' }, consentToggle, element('span', {}, '允许把本批资料发送给所选模型', element('small', {}, '分类只看受限预览，蒸馏只看抽取后的正文'))),
      element('div', { class: 'wiki-actions' },
        actionButton('扫描并入库', () => void run(async () => {
          const value = requireProject()
          if (!consentToggle.checked) throw new Error('请先确认允许发送资料给模型')
          if (!pythonSelect.value) throw new Error('未检测到 Python，请先安装或在下方手动指定')
          if (!providerSelect.value || !modelSelect.value) throw new Error('请选择模型渠道与模型')
          const job = await api(url('ingest'), { method: 'POST', body: {
            python: pythonSelect.value, provider: providerSelect.value, model: modelSelect.value, allowModel: true, scope: value,
          } })
          await loadJobs()
          return `已创建任务 ${job.id.slice(0, 8)}（${job.items.length} 个新文件）`
        }), 'small'),
        actionButton('安装缺失依赖', () => void run(async () => {
          if (!pythonSelect.value) throw new Error('未检测到 Python')
          if (!window.confirm('将用该解释器联网安装缺失的解析库（pypdf / xlrd 等）。继续？')) return
          await api(url('python-install'), { method: 'POST', body: { path: pythonSelect.value } })
          await loadPython()
          return '依赖安装完成'
        }), 'ghost small', { hidden: true, 'data-python-install': '1' }),
        actionButton('重新检测 Python', () => void run(async () => { await loadPython(); return '已重新检测' }), 'ghost small'),
        actionButton('刷新任务', () => void run(loadJobs), 'ghost small')),
      jobList),
    section('页面与 raw', '页面可直接编辑，保存前校验磁盘哈希；raw 只读。',
      element('div', { class: 'wiki-columns' },
        element('div', { class: 'wiki-column' }, element('h3', {}, 'Wiki 页面'), pageList),
        element('div', { class: 'wiki-column' }, element('h3', {}, 'raw（只读）'), rawList, rawView)),
      element('div', { class: 'wiki-editor-bar' }, editorTitle, actionButton('打开文档标准', () => void run(openStandard), 'ghost small'), saveButton),
      editor),
    section('蒸馏更新审核', '模型建议替换现有页时先保存候选，批准后才写文件。',
      element('div', { class: 'wiki-actions' }, actionButton('刷新候选', () => void run(loadProposals), 'ghost small')),
      proposalList),
    status)

  if (bases.length) { state.kbId = bases[0].id; baseSelect.value = state.kbId }
  else status.textContent = '还没有知识库，请先在「知识库与挂载」中创建一个空知识库。'
  void run(reload)
  return { root }
}
