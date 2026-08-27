const API_BASE = document.querySelector('meta[name="dsh-knowledge-api"]')?.content || '/knowledge-api/v1'
const AUTH_MODE = document.querySelector('meta[name="dsh-knowledge-auth-mode"]')?.content || 'bearer'
const HOST_THEME_MESSAGE = '@lemoncat7/dsh-knowledge/host-theme'
const HOST_THEME_READY_MESSAGE = '@lemoncat7/dsh-knowledge/host-theme-ready'
const HOST_THEME_PROTOCOL_VERSION = 1
const HOST_THEME_COLOR_TOKENS = new Set([
  '--bg', '--surface', '--surface-raised', '--surface-soft', '--surface-hover',
  '--text', '--text-secondary', '--text-tertiary', '--border', '--border-strong',
  '--accent', '--accent-hover', '--accent-soft', '--on-accent',
  '--success', '--success-soft', '--warning', '--warning-soft', '--danger', '--danger-soft',
])
const HOST_THEME_STYLE_TOKENS = new Set(['--shadow'])
const TOKEN_KEY = 'dsh-knowledge.session-token'
const TYPES = ['preference', 'fact', 'decision', 'procedure', 'lesson']
const TYPE_LABELS = { preference: '偏好', fact: '事实', decision: '决策', procedure: '流程', lesson: '经验' }
const ACTION_LABELS = { create: '新增', update: '更新', conflict: '冲突' }
const STATUS_LABELS = { active: '生效中', archived: '已归档', pending: '待审核', approved: '已通过', rejected: '已拒绝' }
const CHANGE_LABELS = { create: '创建', update: '更新', archive: '归档', restore: '恢复' }
const WRITE_MODE_LABELS = { none: '仅召回', audit: '审核写入', direct: '直接写入' }
const EVIDENCE_LABELS = { explicit: '用户明确', verified: '结果已验证', inferred: '模型推断' }
const DOCUMENT_STATE_LABELS = { open: '进行中', resolved: '已解决', complete: '已收集完成' }
const DOCUMENT_LAYOUT_KEY = 'dsh-knowledge.document-layout'
const pageParams = new URLSearchParams(location.search)
const mountContext = {
  sessionId: pageParams.get('sessionId')?.trim() || '',
  projectId: pageParams.get('projectId')?.trim() || '',
}
const app = document.querySelector('#app')
const toastRegion = document.querySelector('#toast-region')
const savedDocumentLayout = readDocumentLayout()

function createDocumentViewState(overrides = {}) {
  return {
    knowledgeBaseId: '', documentId: '', query: '', mode: 'preview', treeOpen: false,
    expandedBases: new Set(), editor: null, ...overrides,
  }
}

const state = {
  token: sessionStorage.getItem(TOKEN_KEY) || '',
  view: 'entries',
  menuOpen: false,
  stats: null,
  overview: null,
  knowledgeBases: [],
  knowledgeBaseView: 'libraries',
  knowledgeBaseQuery: '',
  mounts: [],
  resolvedMounts: [],
  mountContext,
  mountManager: {
    targetKind: mountContext.sessionId ? 'session' : 'project',
    query: '',
    filter: 'all',
    selectedIds: new Set(),
  },
  entries: [],
  nextCursor: null,
  entryFilters: { query: '', type: '', status: 'active', projectId: '', knowledgeBaseId: '' },
  documents: [],
  documentView: createDocumentViewState({
    sidebarHidden: savedDocumentLayout.sidebarHidden,
    sidebarWidth: savedDocumentLayout.sidebarWidth,
  }),
  libraryDetail: {
    knowledgeBaseId: '',
    documents: [],
    error: '',
    view: createDocumentViewState(),
  },
  candidates: [],
  candidateTargets: new Map(),
  candidateStatus: 'pending',
  settings: { writebackPolicy: 'conservative', updatedAt: '' },
  modelCatalog: null,
  settingsSaving: false,
  tokens: [],
  service: { publicApiEnabled: false, publicApiPrefix: '/knowledge-api/v1', remote: false },
  scrollPositions: new Map(),
  loading: false,
  error: '',
}

let scrollRestoreFrame = 0

function installHostThemeBridge() {
  if (window.parent === window) return Promise.resolve()
  const parentOrigin = referrerOrigin()
  return new Promise(resolve => {
    let initialThemeSettled = false
    const settleInitialTheme = () => {
      if (initialThemeSettled) return
      initialThemeSettled = true
      window.clearTimeout(fallback)
      resolve()
    }
    const fallback = window.setTimeout(settleInitialTheme, 160)
    window.addEventListener('message', event => {
      if (event.source !== window.parent) return
      if (parentOrigin && event.origin !== parentOrigin) return
      const message = event.data
      if (!message || message.type !== HOST_THEME_MESSAGE || message.version !== HOST_THEME_PROTOCOL_VERSION) return
      if (message.colorScheme !== 'light' && message.colorScheme !== 'dark') return
      if (!message.tokens || typeof message.tokens !== 'object' || Array.isArray(message.tokens)) return

      const root = document.documentElement
      for (const name of [...HOST_THEME_COLOR_TOKENS, ...HOST_THEME_STYLE_TOKENS]) root.style.removeProperty(name)
      for (const [name, value] of Object.entries(message.tokens)) {
        if (typeof value !== 'string' || value.length === 0 || value.length > 512) continue
        if (HOST_THEME_COLOR_TOKENS.has(name) && CSS.supports('color', value)) root.style.setProperty(name, value)
        else if (HOST_THEME_STYLE_TOKENS.has(name) && CSS.supports('box-shadow', value)) root.style.setProperty(name, value)
      }
      root.dataset.dshHostTheme = 'true'
      root.style.colorScheme = message.colorScheme
      root.style.setProperty('--dialog-surface', root.style.getPropertyValue('--surface-raised') || root.style.getPropertyValue('--surface'))
      document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', message.colorScheme)
      const background = root.style.getPropertyValue('--bg')
      if (background) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background)
      settleInitialTheme()
    })
    window.parent.postMessage({
      type: HOST_THEME_READY_MESSAGE,
      version: HOST_THEME_PROTOCOL_VERSION,
    }, parentOrigin || '*')
  })
}

function referrerOrigin() {
  if (!document.referrer) return ''
  try {
    const origin = new URL(document.referrer).origin
    return origin === 'null' ? '' : origin
  } catch {
    return ''
  }
}

function readDocumentLayout() {
  const fallback = {
    sidebarHidden: false,
    sidebarWidth: 236,
  }
  try {
    const value = JSON.parse(localStorage.getItem(DOCUMENT_LAYOUT_KEY) || '{}')
    return {
      sidebarHidden: value.sidebarHidden === true,
      sidebarWidth: clampNumber(value.sidebarWidth, 190, 340, fallback.sidebarWidth),
    }
  } catch { return fallback }
}

function saveDocumentLayout() {
  try {
    localStorage.setItem(DOCUMENT_LAYOUT_KEY, JSON.stringify({
      sidebarHidden: state.documentView.sidebarHidden,
      sidebarWidth: state.documentView.sidebarWidth,
    }))
  } catch {}
}

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.round(number))) : fallback
}

function captureScrollPosition() {
  const shell = app.querySelector('.app-shell[data-view]')
  if (!shell || shell.dataset.loading === 'true') return
  const regions = {}
  shell.querySelectorAll('[data-scroll-key]').forEach(node => {
    const key = node.getAttribute('data-scroll-key')
    if (key) regions[key] = { left: node.scrollLeft, top: node.scrollTop }
  })
  state.scrollPositions.set(shell.dataset.scrollState || shell.dataset.view, {
    window: { left: window.scrollX, top: window.scrollY },
    regions,
  })
}

function currentScrollState() {
  return state.view === 'bases' ? `bases:${state.knowledgeBaseView}` : state.view
}

function restoreScrollPosition(view) {
  if (state.loading) return
  const saved = state.scrollPositions.get(view)
  if (!saved) return
  if (scrollRestoreFrame) window.cancelAnimationFrame(scrollRestoreFrame)
  scrollRestoreFrame = window.requestAnimationFrame(() => {
    window.scrollTo(saved.window.left, saved.window.top)
    app.querySelectorAll('[data-scroll-key]').forEach(node => {
      const position = saved.regions[node.getAttribute('data-scroll-key')]
      if (!position) return
      node.scrollLeft = position.left
      node.scrollTop = position.top
    })
    scrollRestoreFrame = 0
  })
}

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'checked' || key === 'selected' || key === 'disabled') node[key] = Boolean(value)
    else node.setAttribute(key, String(value))
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

function actionButton(label, onClick, variant = '', attributes = {}) {
  return element('button', { type: 'button', class: `button ${variant}`.trim(), onClick, ...attributes }, label)
}

function paneToggleButton(pane, visible, onClick, label) {
  const action = `${visible ? '隐藏' : '显示'}${label}`
  return element('button', {
    type: 'button', class: 'pane-toggle-button', 'data-pane': pane,
    'aria-label': action, 'aria-pressed': String(visible), title: action, onClick,
  }, element('span', { class: `pane-icon pane-icon-${pane}`, 'aria-hidden': 'true' }))
}

function interfaceIcon(name, className = 'interface-icon') {
  const paths = {
    search: 'M10.8 4.5a6.3 6.3 0 1 0 0 12.6 6.3 6.3 0 0 0 0-12.6Zm4.6 11 4.1 4',
  }
  return element('svg', {
    class: className, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  }, element('path', { d: paths[name] }))
}

function badge(label, variant = '') {
  return element('span', { class: `badge ${variant}`.trim() }, label)
}

function showToast(message, kind = '') {
  const toast = element('div', { class: `toast ${kind}`.trim(), role: kind === 'error' ? 'alert' : 'status' }, message)
  toastRegion.append(toast)
  window.setTimeout(() => toast.remove(), 4200)
}

async function api(path, options = {}) {
  const headers = { accept: 'application/json', ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) }
  if (AUTH_MODE === 'same-origin') headers['x-dsh-knowledge-client'] = 'management-web'
  if (state.token) headers.authorization = `Bearer ${state.token}`
  const response = await fetch(`${API_BASE}/${path.replace(/^\/+/, '')}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  })
  const text = await response.text()
  let payload
  if (text) {
    try { payload = JSON.parse(text) } catch { throw new Error('服务返回了无法识别的数据') }
  }
  if (!response.ok) {
    const error = new Error(payload?.error || `请求失败（HTTP ${response.status}）`)
    error.status = response.status
    throw error
  }
  return payload
}

async function boot() {
  if (AUTH_MODE === 'same-origin') {
    state.token = ''
    try { state.service = await api('service') } catch {}
    await navigate('entries')
    return
  }
  if (!state.token) {
    renderLogin()
    return
  }
  try {
    await api('entries?limit=1')
    await navigate('entries')
  } catch (error) {
    sessionStorage.removeItem(TOKEN_KEY)
    state.token = ''
    renderLogin(error.status === 401 ? '令牌无效或已被撤销，请重新输入。' : '暂时无法连接知识库。')
  }
}

function renderLogin(message = '') {
  const tokenInput = element('input', {
    class: 'input', type: 'password', name: 'token', autocomplete: 'current-password',
    placeholder: '输入管理员或只读访问令牌', required: true, autofocus: true,
  })
  const error = element('p', { class: 'login-error', role: 'alert' }, message)
  const submit = actionButton('连接知识库', () => form.requestSubmit(), 'primary')
  const form = element('form', {
    onSubmit: async (event) => {
      event.preventDefault()
      const token = tokenInput.value.trim()
      if (!token) return
      submit.disabled = true
      submit.textContent = '正在连接…'
      error.textContent = ''
      state.token = token
      try {
        await api('entries?limit=1')
        sessionStorage.setItem(TOKEN_KEY, token)
        await navigate('entries')
      } catch (requestError) {
        state.token = ''
        error.textContent = requestError.status === 401 ? '令牌无效或已被撤销。' : '连接失败，请检查服务状态后重试。'
        submit.disabled = false
        submit.textContent = '连接知识库'
        tokenInput.focus()
      }
    },
  },
  element('div', { class: 'field' },
    element('label', { for: 'login-token' }, '访问令牌'),
    Object.assign(tokenInput, { id: 'login-token' }),
    element('span', { class: 'field-hint' }, '令牌仅保存在当前浏览器标签页，关闭后自动清除。'),
  ), error, submit)

  app.replaceChildren(element('main', { class: 'login-page' }, element('section', { class: 'login-card', 'aria-labelledby': 'login-title' },
    element('div', { class: 'brand-mark', 'aria-hidden': 'true' }, 'K'),
    element('h1', { id: 'login-title' }, 'DSH 知识库'),
    element('p', {}, '管理对话中沉淀的长期知识与 AI 提取候选。'),
    form,
  )))
}

function signOut() {
  sessionStorage.removeItem(TOKEN_KEY)
  Object.assign(state, { token: '', stats: null, overview: null, knowledgeBases: [], mounts: [], resolvedMounts: [], entries: [], documents: [], candidates: [], candidateTargets: new Map(), settings: { writebackPolicy: 'conservative', updatedAt: '' }, tokens: [] })
  if (AUTH_MODE === 'same-origin') void boot()
  else renderLogin()
}

async function navigate(view) {
  const previousView = state.view
  if (view === 'bases' && previousView !== 'bases' && state.knowledgeBaseView === 'detail') {
    state.knowledgeBaseView = 'libraries'
  }
  state.view = view
  state.menuOpen = false
  state.loading = true
  state.error = ''
  renderShell()
  try {
    if (view === 'overview') await loadOverview()
    if (view === 'bases') await loadKnowledgeBasesPage()
    if (view === 'entries') await loadDocuments()
    if (view === 'candidates') await loadCandidates()
    if (view === 'tokens') await loadTokens()
  } catch (error) {
    if (error.status === 401 && AUTH_MODE === 'bearer') return signOut()
    state.error = friendlyError(error)
  } finally {
    state.loading = false
    renderShell()
  }
}

async function refreshStats() {
  state.stats = await api('stats')
}

async function ensureKnowledgeBases(force = false) {
  if (force || state.knowledgeBases.length === 0) state.knowledgeBases = await api('knowledge-bases')
  return state.knowledgeBases
}

async function loadKnowledgeBasesPage() {
  const requests = [api('knowledge-bases'), api('mounts'), api('settings'), api('service')]
  if (state.mountContext.sessionId) {
    const params = new URLSearchParams({ sessionId: state.mountContext.sessionId })
    if (state.mountContext.projectId) params.set('projectId', state.mountContext.projectId)
    requests.push(api(`mounts/resolve?${params}`))
  }
  const [bases, mounts, settings, service, resolved = []] = await Promise.all(requests)
  state.knowledgeBases = bases
  state.mounts = mounts
  state.settings = settings
  state.service = service
  state.resolvedMounts = resolved
  await refreshStats()
}

async function loadOverview() {
  const [stats, recent, pending, bases] = await Promise.all([
    api('stats'),
    api('entries?status=active&limit=6'),
    api('candidates?status=pending&limit=5'),
    api('knowledge-bases'),
  ])
  state.stats = stats
  state.knowledgeBases = bases
  state.overview = { recent: recent.items, pending }
}

async function loadEntries(cursor = '') {
  await ensureKnowledgeBases()
  const filters = state.entryFilters
  let result
  if (filters.query.trim() && filters.status === 'active' && !cursor) {
    const params = new URLSearchParams({ q: filters.query.trim(), limit: '100' })
    if (filters.projectId.trim()) params.set('projectId', filters.projectId.trim())
    if (filters.type) params.append('type', filters.type)
    if (filters.knowledgeBaseId) params.append('knowledgeBaseId', filters.knowledgeBaseId)
    const hits = await api(`search?${params}`)
    result = { items: hits.map(hit => hit.entry) }
  } else {
    const params = new URLSearchParams({ limit: '50', status: filters.status })
    if (filters.type) params.set('type', filters.type)
    if (filters.projectId.trim()) params.set('projectId', filters.projectId.trim())
    if (filters.knowledgeBaseId) params.set('knowledgeBaseId', filters.knowledgeBaseId)
    if (cursor) params.set('cursor', cursor)
    result = await api(`entries?${params}`)
  }
  state.entries = cursor ? [...state.entries, ...result.items] : result.items
  state.nextCursor = result.nextCursor || null
  if (!state.stats) await refreshStats()
}

async function loadDocuments() {
  const requests = [api('knowledge-bases'), api('documents')]
  if (state.mountContext.sessionId) {
    const params = new URLSearchParams({ sessionId: state.mountContext.sessionId })
    if (state.mountContext.projectId) params.set('projectId', state.mountContext.projectId)
    requests.push(api(`mounts/resolve?${params}`))
  }
  const [bases, documents, resolved = []] = await Promise.all(requests)
  state.knowledgeBases = bases
  state.resolvedMounts = resolved
  const visibleBaseIds = new Set(documentKnowledgeBases(bases).map(base => base.id))
  state.documents = documents.filter(document => visibleBaseIds.has(document.knowledgeBaseId))
  const workspace = sessionDocumentWorkspace()
  const view = workspace.view
  const availableBaseIds = visibleBaseIds
  if (!view.knowledgeBaseId || !availableBaseIds.has(view.knowledgeBaseId)) {
    view.knowledgeBaseId = state.entryFilters.knowledgeBaseId && availableBaseIds.has(state.entryFilters.knowledgeBaseId)
      ? state.entryFilters.knowledgeBaseId
      : documentKnowledgeBases(bases)[0]?.id || ''
  }
  selectDefaultDocument(workspace)
  if (view.documentId) await loadDocumentEditor(workspace, view.documentId)
  else view.editor = null
  if (!state.stats) await refreshStats()
}

function documentKnowledgeBases(bases = state.knowledgeBases) {
  const active = bases.filter(base => base.status === 'active')
  if (!state.mountContext.sessionId) return active
  const mountedIds = new Set(state.resolvedMounts.map(mount => mount.knowledgeBaseId))
  return active.filter(base => mountedIds.has(base.id))
}

function sessionDocumentWorkspace() {
  return { kind: 'session', view: state.documentView }
}

function libraryDocumentWorkspace() {
  return { kind: 'library', view: state.libraryDetail.view }
}

function activeDocumentWorkspace() {
  if (state.view === 'entries') return sessionDocumentWorkspace()
  if (state.view === 'bases' && state.knowledgeBaseView === 'detail') return libraryDocumentWorkspace()
  return null
}

function documentWorkspaceDocuments(workspace) {
  return workspace.kind === 'library' ? state.libraryDetail.documents : state.documents
}

function setDocumentWorkspaceDocuments(workspace, documents) {
  if (workspace.kind === 'library') state.libraryDetail.documents = documents
  else state.documents = documents
}

function documentWorkspaceBases(workspace) {
  if (workspace.kind === 'library') {
    const base = state.knowledgeBases.find(item => item.id === state.libraryDetail.knowledgeBaseId)
    return base ? [base] : []
  }
  return documentKnowledgeBases()
}

function documentWorkspaceReadOnly(workspace) {
  return workspace.kind === 'library' && documentWorkspaceBases(workspace)[0]?.status === 'archived'
}

async function reloadDocumentWorkspace(workspace) {
  const documents = workspace.kind === 'library'
    ? await api(`documents?knowledgeBaseId=${encodeURIComponent(state.libraryDetail.knowledgeBaseId)}`)
    : await api('documents')
  if (workspace.kind === 'library') setDocumentWorkspaceDocuments(workspace, documents)
  else {
    const visibleBaseIds = new Set(documentKnowledgeBases().map(base => base.id))
    setDocumentWorkspaceDocuments(workspace, documents.filter(document => visibleBaseIds.has(document.knowledgeBaseId)))
  }
}

function selectDefaultDocument(workspace) {
  const view = workspace.view
  const documents = documentWorkspaceDocuments(workspace).filter(document => document.knowledgeBaseId === view.knowledgeBaseId)
  if (!documents.some(document => document.id === view.documentId)) {
    view.documentId = documents[0]?.id || ''
  }
  if (view.knowledgeBaseId) view.expandedBases.add(view.knowledgeBaseId)
}

async function loadDocumentEditor(workspace, id) {
  const entry = await api(`entries/${encodeURIComponent(id)}`)
  workspace.view.mode = 'preview'
  workspace.view.editor = {
    ...entry,
    tagsText: entry.tags.join(', '),
    dirty: false,
    isNew: false,
    saveState: '已保存',
  }
}

function createBlankDocument(workspace, baseId) {
  const base = state.knowledgeBases.find(item => item.id === baseId && item.status === 'active')
  if (!base) return showToast('请先选择一个可用知识库。', 'error')
  const view = workspace.view
  view.knowledgeBaseId = base.id
  view.documentId = ''
  view.mode = 'edit'
  view.treeOpen = false
  view.expandedBases.add(base.id)
  view.editor = {
    id: '', knowledgeBaseId: base.id, title: '', body: '', type: 'fact', tags: [], tagsText: '',
    scope: { kind: 'global' }, confidence: .8, dirty: true, isNew: true, saveState: '新文档',
  }
  renderShell()
  document.querySelector('.note-title-input')?.focus()
}

async function startBlankDocument(workspace, baseId) {
  const editor = workspace.view.editor
  const emptyDraft = editor?.isNew && !editor.title.trim() && !editor.body.trim()
  if (editor?.dirty && !emptyDraft && !await saveDocumentEditor(workspace)) return
  createBlankDocument(workspace, baseId)
}

async function selectDocument(workspace, id) {
  const editor = workspace.view.editor
  const emptyDraft = editor?.isNew && !editor.title.trim() && !editor.body.trim()
  if (editor?.dirty && !emptyDraft && !await saveDocumentEditor(workspace)) return
  workspace.view.documentId = id
  workspace.view.treeOpen = false
  await loadDocumentEditor(workspace, id)
  renderShell()
}

function editorDraft(editor) {
  return {
    knowledgeBaseId: editor.knowledgeBaseId,
    title: editor.title.trim(),
    body: editor.body.trim(),
    type: editor.type,
    tags: parseTags(editor.tagsText),
    scope: editor.scope,
    confidence: editor.confidence,
    ...(editor.source ? { source: editor.source } : {}),
  }
}

async function saveDocumentEditor(workspace = activeDocumentWorkspace()) {
  if (!workspace) return false
  const editor = workspace.view.editor
  if (!editor || !editor.dirty) return true
  if (!editor.isNew && editor.documentState !== 'open') {
    showToast('这篇文档已经结束并封存；请先重新打开。', 'error')
    return false
  }
  if (!editor.title.trim() || !editor.body.trim()) {
    showToast('标题和正文填写完整后才能保存。', 'error')
    return false
  }
  editor.saveState = '正在保存…'
  updateEditorSaveState(editor.saveState)
  try {
    const draft = editorDraft(editor)
    const saved = editor.isNew
      ? await api('entries', { method: 'POST', body: { draft } })
      : await api(`entries/${encodeURIComponent(editor.id)}`, { method: 'PUT', body: { draft } })
    editor.id = saved.id
    editor.isNew = false
    editor.dirty = false
    editor.updatedAt = saved.updatedAt
    editor.saveState = '已保存'
    workspace.view.documentId = saved.id
    updateEditorSaveState(editor.saveState)
    await reloadDocumentWorkspace(workspace)
    return true
  } catch (error) {
    editor.saveState = '保存失败'
    updateEditorSaveState(editor.saveState)
    showToast(friendlyError(error), 'error')
    return false
  }
}

function updateEditorSaveState(label) {
  const node = document.querySelector('.editor-save-status')
  if (node) node.textContent = label
}

async function loadCandidates() {
  const [candidates] = await Promise.all([
    api(`candidates?status=${state.candidateStatus}&limit=100`),
    ensureKnowledgeBases(),
  ])
  state.candidates = candidates
  const targetIds = [...new Set(candidates.map(candidate => candidate.targetId).filter(Boolean))]
  const targets = await Promise.all(targetIds.map(async id => {
    try { return [id, await api(`entries/${encodeURIComponent(id)}`)] }
    catch { return [id, null] }
  }))
  state.candidateTargets = new Map(targets)
  if (!state.stats) await refreshStats()
}

async function loadTokens() {
  const [tokens, service] = await Promise.all([api('tokens'), api('service')])
  state.tokens = tokens
  state.service = service
  if (!state.stats) await refreshStats()
}

function renderShell() {
  captureScrollPosition()
  const titles = {
    overview: ['概览', '知识库运行状态与最近活动'],
    bases: ['知识库与挂载', '管理知识目录，并限定项目与会话的召回和写入范围'],
    entries: ['知识文档', '在知识目录中阅读、整理和维护 Markdown 文档'],
    candidates: ['待审核', '确认 AI 提取结果后再写入知识文档'],
    tokens: ['访问管理', '管理其他客户端连接中央知识库的权限'],
  }
  const [title, subtitle] = titles[state.view]
  const shell = element('div', {
    class: 'app-shell', 'data-menu-open': String(state.menuOpen),
    'data-view': state.view, 'data-loading': String(state.loading),
    'data-scroll-state': currentScrollState(),
    'data-base-detail': String(state.view === 'bases' && state.knowledgeBaseView === 'detail'),
    'data-sidebar-hidden': String(state.documentView.sidebarHidden),
    style: `--sidebar-width: ${state.documentView.sidebarWidth}px`,
  },
    renderSidebar(),
    renderAppSidebarResizer(),
    element('main', { class: 'main' },
      element('header', { class: 'topbar' },
        element('div', { class: 'topbar-title' },
          actionButton('☰', () => { state.menuOpen = !state.menuOpen; renderShell() }, 'ghost mobile-menu', { 'aria-label': '打开导航菜单' }),
          paneToggleButton('main', !state.documentView.sidebarHidden, () => setSidebarHidden(!state.documentView.sidebarHidden), '主导航栏'),
          activeDocumentWorkspace() ? paneToggleButton('library', activeDocumentWorkspace().view.treeOpen, () => {
            const workspace = activeDocumentWorkspace()
            if (!workspace) return
            workspace.view.treeOpen = !workspace.view.treeOpen
            renderShell()
          }, '知识目录') : null,
          element('div', {}, element('h1', {}, title), element('p', {}, subtitle)),
        ),
      ),
      element('div', { class: 'page' }, renderCurrentView()),
    ),
  )
  if (state.menuOpen) shell.addEventListener('click', (event) => {
    if (event.target === shell) { state.menuOpen = false; renderShell() }
  })
  app.replaceChildren(shell)
  restoreScrollPosition(currentScrollState())
}

function renderAppSidebarResizer() {
  const minimum = 190
  const maximum = 340
  const value = state.documentView.sidebarWidth
  return element('div', {
    class: 'app-sidebar-resizer', role: 'separator', tabindex: '0',
    title: '拖动调整主导航栏宽度',
    'aria-label': '调整主导航栏宽度', 'aria-orientation': 'vertical',
    'aria-valuemin': minimum, 'aria-valuemax': maximum, 'aria-valuenow': value,
    onPointerDown: event => startSidebarResize(event, minimum, maximum),
    onKeyDown: event => resizeSidebarWithKeyboard(event, minimum, maximum),
  }, element('span', { 'aria-hidden': 'true' }, '⋮'))
}

function startSidebarResize(event, minimum, maximum) {
  if (event.button !== 0) return
  event.preventDefault()
  const handle = event.currentTarget
  const shell = handle.closest('.app-shell')
  if (!shell) return
  const startX = event.clientX
  const startWidth = state.documentView.sidebarWidth
  handle.setPointerCapture?.(event.pointerId)
  handle.classList.add('is-dragging')
  document.body.classList.add('is-resizing-columns')
  const move = moveEvent => {
    const width = clampNumber(startWidth + moveEvent.clientX - startX, minimum, maximum, startWidth)
    setSidebarWidth(width, shell, handle)
  }
  const finish = () => {
    handle.classList.remove('is-dragging')
    document.body.classList.remove('is-resizing-columns')
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', finish)
    handle.removeEventListener('pointercancel', finish)
    saveDocumentLayout()
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', finish)
  handle.addEventListener('pointercancel', finish)
}

function resizeSidebarWithKeyboard(event, minimum, maximum) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const current = state.documentView.sidebarWidth
  const width = event.key === 'Home' ? minimum
    : event.key === 'End' ? maximum
    : clampNumber(current + (event.key === 'ArrowRight' ? 16 : -16), minimum, maximum, current)
  setSidebarWidth(width, event.currentTarget.closest('.app-shell'), event.currentTarget)
  saveDocumentLayout()
}

function setSidebarWidth(width, shell, handle) {
  state.documentView.sidebarWidth = width
  shell?.style.setProperty('--sidebar-width', `${width}px`)
  handle?.setAttribute('aria-valuenow', String(width))
}

function setSidebarHidden(hidden) {
  state.documentView.sidebarHidden = hidden
  saveDocumentLayout()
  renderShell()
}

function renderSidebar() {
  const pending = state.stats?.candidates.pending
  const navGroups = [
    ['知识工作区', [['entries', '文档'], ['candidates', '待审核'], ['bases', '知识库与挂载']]],
    ['连接', [['tokens', '访问管理']].filter(([id]) => id !== 'tokens' || !state.service.remote)],
  ].filter(([, items]) => items.length)
  return element('aside', { class: 'sidebar', 'aria-label': '知识库导航' },
    element('div', { class: 'brand' },
      element('div', { class: 'brand-copy' }, element('span', {}, 'DSH Knowledge'), element('strong', {}, '知识库')),
    ),
    element('nav', { class: 'nav' }, navGroups.map(([group, items]) => element('div', { class: 'nav-group' },
      element('div', { class: 'nav-group-label' }, group),
      items.map(([id, label]) => element('button', {
        type: 'button', class: 'nav-button', 'aria-current': state.view === id ? 'page' : undefined,
        onClick: () => navigate(id),
      }, element('span', { class: 'nav-label' }, label),
      id === 'candidates' && pending ? element('span', { class: 'nav-count', 'aria-label': `${pending} 条待审核` }, pending) : null))))),
    element('div', { class: 'sidebar-footer' },
      element('div', { class: 'connection' }, element('span', { class: 'status-dot', 'aria-hidden': 'true' }), state.service.remote ? '中央知识库已连接' : '本地知识库已连接'),
      AUTH_MODE === 'bearer' ? actionButton('退出当前会话', signOut, 'ghost small') : null,
    ),
  )
}

function renderCurrentView() {
  if (state.loading) return loadingView()
  if (state.error) return errorView(state.error, () => navigate(state.view))
  if (state.view === 'overview') return renderOverview()
  if (state.view === 'bases') return renderKnowledgeBases()
  if (state.view === 'entries') return renderEntries()
  if (state.view === 'candidates') return renderCandidates()
  return renderTokens()
}

function loadingView() {
  return element('div', { class: 'loading-skeleton', role: 'status', 'aria-label': '正在加载' },
    element('span', { class: 'visually-hidden' }, '正在加载'),
    element('div', { class: 'skeleton-line skeleton-title', 'aria-hidden': 'true' }),
    element('div', { class: 'skeleton-line skeleton-copy', 'aria-hidden': 'true' }),
    element('div', { class: 'skeleton-grid', 'aria-hidden': 'true' },
      element('div', { class: 'skeleton-block' }),
      element('div', { class: 'skeleton-block' }),
      element('div', { class: 'skeleton-block' }),
    ),
  )
}

function errorView(message, retry) {
  return element('div', { class: 'error-state', role: 'alert' }, element('p', {}, message), actionButton('重试', retry, 'small'))
}

function renderOverview() {
  const stats = state.stats
  const overview = state.overview
  if (!stats || !overview) return loadingView()
  const metrics = [
    ['生效知识', stats.entries.active, `${stats.entries.archived} 条已归档`],
    ['待审核候选', stats.candidates.pending, `${stats.candidates.approved} 条已通过`],
    ['提取任务', stats.extractionJobs.total, `${stats.extractionJobs.failed} 个失败`],
    ['知识类型', Object.values(stats.entries.byType).filter(Boolean).length, '共 5 种分类'],
  ]
  return element('div', {},
    element('section', { class: 'metrics', 'aria-label': '知识库指标' }, metrics.map(([label, value, detail]) => element('article', { class: 'metric' },
      element('div', { class: 'metric-label' }, label),
      element('strong', { class: 'metric-value' }, value),
      element('div', { class: 'metric-detail' }, detail),
    ))),
    element('div', { class: 'dashboard-grid' },
      element('section', { class: 'panel', 'aria-labelledby': 'recent-title' },
        element('div', { class: 'panel-header' }, element('h2', { id: 'recent-title' }, '最近更新'), actionButton('查看全部', () => navigate('entries'), 'ghost small')),
        element('div', { class: 'panel-body' }, overview.recent.length ? element('div', { class: 'list' }, overview.recent.map(renderCompactEntry)) : compactEmpty('还没有已生效知识')),
      ),
      element('section', { class: 'panel', 'aria-labelledby': 'pending-title' },
        element('div', { class: 'panel-header' }, element('h2', { id: 'pending-title' }, '等待确认'), actionButton('进入审核', () => navigate('candidates'), 'ghost small')),
        element('div', { class: 'panel-body' }, overview.pending.length ? element('div', { class: 'list' }, overview.pending.map(renderCompactCandidate)) : compactEmpty('当前没有待审核候选')),
      ),
    ),
  )
}

function renderKnowledgeBases() {
  const activeBases = state.knowledgeBases.filter(base => base.status === 'active')
  const archivedBases = state.knowledgeBases.filter(base => base.status === 'archived')
  if (state.knowledgeBaseView === 'detail') return renderKnowledgeBaseDetail()
  const contextAvailable = Boolean(state.mountContext.projectId || state.mountContext.sessionId)
  const query = state.knowledgeBaseQuery.trim().toLocaleLowerCase()
  const matchesQuery = base => !query || [base.name, base.description, base.defaultTags.join(' ')]
    .some(value => String(value || '').toLocaleLowerCase().includes(query))
  const visibleActiveBases = activeBases.filter(matchesQuery)
  const visibleArchivedBases = archivedBases.filter(matchesQuery)
  const switcher = element('div', { class: 'workspace-switcher' },
    element('div', { class: 'workspace-switcher-leading' },
      element('div', { class: 'tabs workspace-tabs', role: 'tablist', 'aria-label': '知识库管理范围' }, [
      ['libraries', '知识库', activeBases.length],
      ['mounts', '项目与会话挂载', state.mounts.filter(mount => mount.enabled).length],
    ].map(([id, label, count]) => element('button', {
      type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(state.knowledgeBaseView === id),
      onClick: () => { state.knowledgeBaseView = id; renderShell() },
      }, element('span', {}, label), element('span', { class: 'tab-count' }, count)))),
      actionButton('本机回写模型', () => openGlobalWritebackModelEditor(), 'ghost small'),
    ),
    element('p', {}, state.service.writebackProvider && state.service.writebackModel
      ? `仅当前客户端使用 ${state.service.writebackProvider} / ${state.service.writebackModel} 回写。`
      : '当前客户端跟随每轮会话模型回写。'),
  )
  return element('div', { class: 'bases-page' },
    switcher,
    state.knowledgeBaseView === 'libraries' ? element('section', { class: 'library-management', 'aria-labelledby': 'bases-heading' },
      element('div', { class: 'section-heading' },
        element('div', {}, element('h2', { id: 'bases-heading' }, '我的知识库'), element('p', {}, '名称和描述帮助 AI 判断知识应该写到哪里。')),
        actionButton('+ 创建知识库', () => openKnowledgeBaseEditor(), 'primary'),
      ),
      element('div', { class: 'knowledge-base-toolbar' },
        element('div', { class: 'search-box base-search' }, interfaceIcon('search', 'search-symbol'), element('input', {
          class: 'input', type: 'search', value: state.knowledgeBaseQuery,
          placeholder: '搜索名称、描述或标签', 'aria-label': '搜索知识库',
          onInput: event => {
            state.knowledgeBaseQuery = event.target.value
            renderShell()
            document.querySelector('.base-search input')?.focus()
          },
        })),
        element('div', { class: 'base-result-summary', 'aria-live': 'polite' }, query
          ? `找到 ${visibleActiveBases.length + visibleArchivedBases.length} 个知识库`
          : `${activeBases.length} 个可用 · ${archivedBases.length} 个已归档`),
      ),
      visibleActiveBases.length
        ? element('div', { class: 'base-grid' }, visibleActiveBases.map(renderKnowledgeBaseCard))
        : query && visibleArchivedBases.length === 0
          ? emptyState('没有匹配的知识库', '尝试搜索名称、描述或标签。')
          : !query ? emptyState('还没有可用知识库', '使用右上角按钮创建第一个知识库。') : null,
      visibleArchivedBases.length ? element('details', { class: 'archived-bases', open: Boolean(query) },
        element('summary', {}, element('span', {}, '已归档知识库'), element('span', { class: 'summary-count' }, visibleArchivedBases.length)),
        element('div', { class: 'base-grid' }, visibleArchivedBases.map(renderKnowledgeBaseCard)),
      ) : null,
    ) : element('section', { class: 'mount-section', 'aria-labelledby': 'mounts-heading' },
      element('div', { class: 'section-heading' }, element('div', {},
        element('h2', { id: 'mounts-heading' }, '挂载范围'),
        element('p', {}, '会话默认继承项目；只有需要差异时才创建会话覆盖。'),
      )),
      contextAvailable
        ? element('div', { class: 'mount-context' },
          state.mountContext.projectId ? contextPill('项目', state.mountContext.projectId) : contextPill('项目', '当前页面未提供'),
          state.mountContext.sessionId ? contextPill('会话', state.mountContext.sessionId) : contextPill('会话', '当前页面未提供'),
        )
        : element('div', { class: 'context-warning' }, '请从 DSH 当前会话的左侧“知识库”入口打开，才能管理当前项目和会话的挂载。'),
      contextAvailable && activeBases.length
        ? renderMountManager(activeBases)
        : null,
    ),
  )
}

async function openKnowledgeBaseDocuments(base) {
  captureScrollPosition()
  const detail = state.libraryDetail
  const changingBase = detail.knowledgeBaseId !== base.id
  detail.knowledgeBaseId = base.id
  if (changingBase) {
    detail.documents = []
    detail.view = createDocumentViewState({ knowledgeBaseId: base.id })
  } else {
    detail.view.knowledgeBaseId = base.id
  }
  state.knowledgeBaseView = 'detail'
  state.loading = true
  detail.error = ''
  renderShell()
  const workspace = libraryDocumentWorkspace()
  try {
    await reloadDocumentWorkspace(workspace)
    selectDefaultDocument(workspace)
    if (workspace.view.documentId) await loadDocumentEditor(workspace, workspace.view.documentId)
    else workspace.view.editor = null
  } catch (error) {
    detail.error = friendlyError(error)
  } finally {
    state.loading = false
    renderShell()
    window.requestAnimationFrame(() => document.querySelector('.library-detail-back')?.focus())
  }
}

async function closeKnowledgeBaseDetail() {
  const workspace = libraryDocumentWorkspace()
  const editor = workspace.view.editor
  const emptyDraft = editor?.isNew && !editor.title.trim() && !editor.body.trim()
  if (editor?.dirty && !emptyDraft && !await saveDocumentEditor(workspace)) return
  const baseId = state.libraryDetail.knowledgeBaseId
  state.knowledgeBaseView = 'libraries'
  state.libraryDetail.error = ''
  renderShell()
  window.requestAnimationFrame(() => document.querySelector(`[data-open-knowledge-base="${CSS.escape(baseId)}"]`)?.focus())
}

function renderKnowledgeBaseDetail() {
  const base = state.knowledgeBases.find(item => item.id === state.libraryDetail.knowledgeBaseId)
  if (!base) return emptyState('知识库不可用', '它可能已被删除，请返回知识库列表重新选择。', '返回我的知识库', () => { state.knowledgeBaseView = 'libraries'; renderShell() })
  const workspace = libraryDocumentWorkspace()
  const archived = base.status === 'archived'
  const mountStatus = state.mountContext.sessionId
    ? mountView(base, 'session', state.mountContext.sessionId)
    : state.mountContext.projectId ? mountView(base, 'project', state.mountContext.projectId) : null
  return element('section', { class: 'library-detail', 'aria-labelledby': 'library-detail-title' },
    element('header', { class: 'library-detail-header' },
      actionButton('我的知识库', () => { void closeKnowledgeBaseDetail() }, 'ghost small library-detail-back', { 'aria-label': '返回我的知识库' }),
      element('div', { class: 'library-detail-identity' },
        element('span', { class: 'base-symbol', 'aria-hidden': 'true' }, base.name.trim().slice(0, 1).toLocaleUpperCase() || 'K'),
        element('div', {},
          element('div', { class: 'library-detail-title-line' },
            element('h2', { id: 'library-detail-title' }, base.name),
            badge(archived ? '已归档' : '可用', archived ? '' : 'success'),
            mountStatus ? badge(mountStatus.statusLabel, mountStatus.statusVariant) : badge('未选择挂载范围'),
          ),
          element('p', {}, base.description || '通用知识库，尚未设置匹配描述。'),
        ),
      ),
      element('div', { class: 'library-detail-actions' },
        archived ? actionButton('恢复知识库', () => confirmRestoreKnowledgeBase(base), 'small') : actionButton('编辑知识库', () => openKnowledgeBaseEditor(base), 'small'),
        !archived ? actionButton('+ 新建文档', () => { void startBlankDocument(workspace, base.id) }, 'primary small') : null,
      ),
    ),
    archived ? element('div', { class: 'library-detail-notice', role: 'status' }, '这个知识库已经归档。文档仍可阅读，但恢复知识库后才能新建或修改。') : null,
    state.libraryDetail.error
      ? errorView(state.libraryDetail.error, () => { void openKnowledgeBaseDocuments(base) })
      : renderDocumentWorkspace(workspace, { heading: base.name, singleBase: true }),
  )
}

async function openGlobalWritebackModelEditor() {
  await loadModelCatalog()
  const custom = element('input', { type: 'checkbox', checked: Boolean(state.service.writebackProvider && state.service.writebackModel) })
  const route = modelRouteFields(state.service.writebackProvider || '', state.service.writebackModel || '')
  const form = element('form', { class: 'form-grid' },
    element('label', { class: 'check-option span-2' }, custom, element('span', {}, element('strong', {}, '当前客户端使用专用模型'), element('small', {}, '关闭后，跟随当前客户端每轮会话实际使用的模型。'))),
    route.provider.wrapper, route.model.wrapper,
  )
  const sync = () => { route.provider.input.disabled = route.model.input.disabled = !custom.checked; route.provider.input.required = route.model.input.required = custom.checked }
  custom.addEventListener('change', sync); sync()
  openSheet({ title: '本机回写模型', description: '此设置只保存在当前 DSH 客户端，不会写入中央知识库或影响其他设备。', body: form, primaryLabel: '保存', onPrimary: async () => {
    if (!form.reportValidity()) return false
    state.service = await api('service', { method: 'PUT', body: custom.checked
      ? { writebackProvider: route.provider.input.value, writebackModel: route.model.input.value }
      : { writebackProvider: null, writebackModel: null } })
    showToast('当前客户端的回写模型已更新。'); renderShell(); return true
  } })
}

function contextPill(label, value) {
  return element('div', { class: 'context-pill' }, element('strong', {}, label), element('span', { title: value }, value))
}

function renderKnowledgeBaseCard(base) {
  const archived = base.status === 'archived'
  const visibleTags = base.defaultTags.slice(0, 4)
  const hiddenTagCount = Math.max(0, base.defaultTags.length - visibleTags.length)
  return element('article', { class: `base-card${archived ? ' is-archived' : ''}` },
    element('div', { class: 'base-card-header' },
      element('div', { class: 'base-card-identity' },
        element('span', { class: 'base-symbol', 'aria-hidden': 'true' }, base.name.trim().slice(0, 1).toLocaleUpperCase() || 'K'),
        element('div', {}, element('h3', {}, base.name), element('small', { title: base.id }, base.id === 'default' ? '系统默认库' : `ID · ${base.id}`)),
      ),
      badge(archived ? '已归档' : '可用', archived ? '' : 'success'),
    ),
    element('p', { class: 'base-description' }, base.description || '通用知识库，尚未设置匹配描述。'),
    element('div', { class: 'base-card-tags' }, visibleTags.length
      ? visibleTags.map(tag => element('span', { class: 'tag' }, `#${tag}`))
      : element('span', { class: 'tag is-empty' }, '无默认标签'),
    hiddenTagCount ? element('span', { class: 'tag' }, `+${hiddenTagCount}`) : null),
    element('div', { class: 'base-card-meta' },
      element('span', {}, element('strong', {}, '回写策略'), base.writebackPolicy === 'proactive' ? '主动' : '严谨'),
      element('span', {}, element('strong', {}, '回写模型'), state.service.writebackProvider && state.service.writebackModel ? `本机 · ${state.service.writebackProvider} / ${state.service.writebackModel}` : '跟随当前会话'),
      base.extractionInstructions ? element('span', {}, element('strong', {}, '提取规则'), '已设置') : null,
    ),
    element('div', { class: 'base-card-actions' },
      actionButton('查看知识', () => { void openKnowledgeBaseDocuments(base) }, 'ghost small', { 'data-open-knowledge-base': base.id }),
      archived ? actionButton('恢复', () => confirmRestoreKnowledgeBase(base), 'small') : actionButton('编辑', () => openKnowledgeBaseEditor(base), 'small'),
      archived ? actionButton('永久删除', () => confirmDeleteKnowledgeBase(base), 'danger small') : null,
      !archived && base.id !== 'default' ? actionButton('归档', () => confirmArchiveKnowledgeBase(base), 'danger small') : null,
    ),
  )
}

function findExplicitMount(baseId, targetKind, targetId) {
  return state.mounts.find(mount => mount.knowledgeBaseId === baseId && mount.targetKind === targetKind && mount.targetId === targetId)
}

function mountView(base, targetKind, targetId) {
  const explicit = findExplicitMount(base.id, targetKind, targetId)
  const inherited = targetKind === 'session' && !explicit && state.mountContext.projectId
    ? findExplicitMount(base.id, 'project', state.mountContext.projectId)
    : undefined
  const source = explicit || (inherited?.enabled ? inherited : undefined)
  let statusKey
  let statusLabel
  let statusVariant = ''
  let detail
  if (explicit && !explicit.enabled) {
    statusKey = 'disabled'
    statusLabel = '已关闭'
    statusVariant = 'danger'
    detail = '显式禁用，不会继承项目设置'
  } else if (source) {
    statusKey = explicit ? 'mounted' : 'inherited'
    statusLabel = explicit ? '已挂载' : '继承项目'
    statusVariant = explicit ? 'success' : 'accent'
    detail = `${source.recallEnabled ? '召回开启' : '召回关闭'} · ${WRITE_MODE_LABELS[source.writeMode]}`
  } else {
    statusKey = 'unmounted'
    statusLabel = '未挂载'
    detail = '不召回、不提取、不回写'
  }
  return { explicit, inherited, source, statusKey, statusLabel, statusVariant, detail }
}

function renderMountManager(activeBases) {
  const manager = state.mountManager
  const availableKinds = [
    state.mountContext.projectId ? ['project', '项目'] : null,
    state.mountContext.sessionId ? ['session', '会话'] : null,
  ].filter(Boolean)
  if (!availableKinds.some(([kind]) => kind === manager.targetKind)) manager.targetKind = availableKinds[0][0]
  const targetId = manager.targetKind === 'project' ? state.mountContext.projectId : state.mountContext.sessionId
  const query = manager.query.trim().toLowerCase()
  const rows = activeBases.map(base => ({ base, view: mountView(base, manager.targetKind, targetId) }))
  const visibleRows = rows.filter(({ base, view }) => {
    const searchable = `${base.name} ${base.description} ${base.defaultTags.join(' ')}`.toLowerCase()
    return (!query || searchable.includes(query)) && (manager.filter === 'all' || manager.filter === view.statusKey)
  })
  const visibleIds = visibleRows.map(({ base }) => base.id)
  const selectedCount = manager.selectedIds.size
  const searchInput = element('input', {
    class: 'input', type: 'search', value: manager.query,
    placeholder: '搜索名称、描述或标签', 'aria-label': '搜索可挂载知识库',
    onInput: (event) => { manager.query = event.target.value; renderShell() },
  })
  const filter = selectControl('筛选挂载状态', [
    { value: 'all', label: '全部状态' },
    { value: 'mounted', label: '已挂载' },
    { value: 'unmounted', label: '未挂载' },
    ...(manager.targetKind === 'session' ? [{ value: 'inherited', label: '继承项目' }] : []),
    { value: 'disabled', label: '已关闭' },
  ], manager.filter, (value) => { manager.filter = value; renderShell() })
  return element('div', { class: 'mount-manager' },
    element('div', { class: 'mount-manager-toolbar' },
      element('div', { class: 'tabs', role: 'tablist', 'aria-label': '挂载目标' }, availableKinds.map(([kind, label]) => element('button', {
        type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(manager.targetKind === kind),
        onClick: () => {
          manager.targetKind = kind
          manager.filter = 'all'
          manager.selectedIds.clear()
          renderShell()
        },
      }, label))),
      element('div', { class: 'search-box mount-search' }, interfaceIcon('search', 'search-symbol'), searchInput),
      filter,
    ),
    element('div', { class: 'mount-target-line' },
      element('span', {}, manager.targetKind === 'project' ? '当前项目' : '当前会话'),
      element('code', { title: targetId }, targetId),
      element('span', { class: 'field-hint' }, `显示 ${visibleRows.length} / ${activeBases.length}`),
    ),
    visibleRows.length
      ? element('div', { class: 'mount-table', role: 'list', 'aria-label': '知识库挂载列表', 'data-scroll-key': 'mount-table' }, visibleRows.map(({ base, view }) => renderMountListRow(base, view, manager.targetKind, targetId)))
      : emptyState('没有匹配的知识库', '调整搜索词或筛选条件。'),
    element('div', { class: 'mount-bulk-bar', 'aria-live': 'polite' },
      element('strong', {}, `已选择 ${selectedCount} 个`),
      element('div', { class: 'mount-bulk-actions' },
        actionButton('选择当前结果', () => { visibleIds.forEach(id => manager.selectedIds.add(id)); renderShell() }, 'ghost small', { disabled: visibleIds.length === 0 }),
        actionButton('清除选择', () => { manager.selectedIds.clear(); renderShell() }, 'ghost small', { disabled: selectedCount === 0 }),
        actionButton(manager.targetKind === 'session' ? '恢复继承' : '取消挂载', () => void bulkRemoveMounts(), 'danger small', { disabled: selectedCount === 0 }),
        actionButton('批量挂载', () => openBulkMountEditor(), 'primary small', { disabled: selectedCount === 0 }),
      ),
    ),
  )
}

function renderMountListRow(base, view, targetKind, targetId) {
  const selected = state.mountManager.selectedIds.has(base.id)
  const checkbox = element('input', {
    type: 'checkbox', checked: selected, 'aria-label': `选择 ${base.name}`,
    onChange: (event) => {
      if (event.target.checked) state.mountManager.selectedIds.add(base.id)
      else state.mountManager.selectedIds.delete(base.id)
      renderShell()
    },
  })
  const modelLabel = state.service.writebackProvider && state.service.writebackModel
    ? `本机 · ${state.service.writebackProvider} / ${state.service.writebackModel}`
    : '跟随当前会话模型'
  return element('article', { class: `mount-list-row${selected ? ' is-selected' : ''}`, role: 'listitem' },
    element('label', { class: 'mount-select' }, checkbox, element('span', { class: 'visually-hidden' }, `选择 ${base.name}`)),
    element('div', { class: 'mount-list-main' },
      element('div', { class: 'mount-list-title' }, element('strong', {}, base.name), badge(view.statusLabel, view.statusVariant), badge(modelLabel)),
      element('p', {}, base.description || '通用知识库'),
      element('div', { class: 'mount-list-meta' }, view.detail,
        view.source?.includeTags.length ? element('span', {}, ` · 包含 #${view.source.includeTags.join(' #')}`) : null,
        view.source?.excludeTags.length ? element('span', {}, ` · 排除 #${view.source.excludeTags.join(' #')}`) : null,
      ),
    ),
    actionButton(view.explicit ? '设置' : view.inherited?.enabled ? '覆盖' : '挂载', () => openMountEditor(base, targetKind, targetId, view.explicit, view.inherited), 'small'),
  )
}

function renderCompactEntry(entry) {
  return element('article', { class: 'list-row' },
    element('div', { class: 'list-main' },
      element('div', { class: 'list-title' }, element('strong', {}, entry.title), badge(TYPE_LABELS[entry.type])),
      element('p', { class: 'list-summary' }, entry.body),
      element('div', { class: 'list-meta' }, knowledgeBaseName(entry.knowledgeBaseId), scopeLabel(entry.scope), formatDate(entry.updatedAt)),
    ),
    actionButton('编辑', () => openEntryEditor(entry), 'ghost small'),
  )
}

function renderCompactCandidate(candidate) {
  return element('article', { class: 'list-row' },
    element('div', { class: 'list-main' },
      element('div', { class: 'list-title' }, element('strong', {}, candidate.draft.title), badge(ACTION_LABELS[candidate.action], candidate.action === 'conflict' ? 'warning' : 'accent')),
      element('p', { class: 'list-summary' }, candidate.reason || candidate.draft.body),
      element('div', { class: 'list-meta' }, knowledgeBaseName(candidate.draft.knowledgeBaseId), TYPE_LABELS[candidate.draft.type], formatDate(candidate.createdAt)),
    ),
    actionButton('审核', () => navigate('candidates'), 'ghost small'),
  )
}

function compactEmpty(message) {
  return element('div', { class: 'loading' }, message)
}

function renderEntries() {
  return renderDocumentWorkspace(sessionDocumentWorkspace(), { heading: '知识目录' })
}

function renderDocumentWorkspace(workspace, options = {}) {
  const view = workspace.view
  const query = view.query.trim().toLocaleLowerCase()
  const activeBases = documentWorkspaceBases(workspace)
  const workspaceDocuments = documentWorkspaceDocuments(workspace)
  const readOnly = documentWorkspaceReadOnly(workspace)
  const selectedBase = activeBases.find(base => base.id === view.knowledgeBaseId)
  const search = element('input', {
    class: 'note-tree-search', type: 'search', value: view.query, placeholder: '搜索文档', 'aria-label': '搜索知识库文档',
    'data-document-scope': workspace.kind,
    onInput: (event) => {
      view.query = event.target.value
      renderShell()
      const input = document.querySelector(`.note-tree-search[data-document-scope="${workspace.kind}"]`)
      input?.focus()
      input?.setSelectionRange(input.value.length, input.value.length)
    },
  })
  const tree = activeBases.map(base => {
    const expanded = view.expandedBases.has(base.id) || Boolean(query)
    const documents = workspaceDocuments.filter(document => document.knowledgeBaseId === base.id
      && (!query || [document.title, document.relPath, document.content].some(value => value.toLocaleLowerCase().includes(query))))
    return element('section', { class: 'note-tree-group', 'data-expanded': String(expanded) },
      element('button', {
        type: 'button', class: 'note-tree-base', 'aria-expanded': String(expanded),
        onClick: () => {
          view.knowledgeBaseId = base.id
          if (expanded && !query) view.expandedBases.delete(base.id)
          else view.expandedBases.add(base.id)
          renderShell()
        },
      },
      element('span', { class: 'tree-disclosure', 'aria-hidden': 'true' }),
      element('span', { class: 'tree-folder-icon', 'aria-hidden': 'true' }),
      element('span', { class: 'tree-base-name' }, base.name),
      element('span', { class: 'tree-count' }, documents.length)),
      expanded ? element('div', { class: 'note-tree-documents', role: 'group', 'aria-label': `${base.name}文档` },
        documents.map(document => element('button', {
          type: 'button', class: 'note-tree-document', 'aria-current': document.id === view.documentId ? 'page' : undefined,
          onClick: () => { void selectDocument(workspace, document.id) },
        }, element('span', { class: 'tree-document-icon', 'aria-hidden': 'true' }), element('span', { class: 'tree-document-copy' },
          element('strong', {}, document.title), element('small', {}, document.relPath)),
        document.documentState !== 'open' ? badge(DOCUMENT_STATE_LABELS[document.documentState] || '已结束', 'success') : null)),
        !query && !readOnly ? element('button', { type: 'button', class: 'note-tree-new', onClick: () => { void startBlankDocument(workspace, base.id) } },
          element('span', { 'aria-hidden': 'true' }, '+'), '新建文档') : null,
      ) : null,
    )
  })
  return element('section', {
    class: `note-workspace note-workspace--${workspace.kind}`, 'aria-labelledby': `${workspace.kind}-documents-heading`,
    'data-tree-open': String(view.treeOpen),
  },
    element('aside', { class: 'note-tree-panel', 'aria-label': '知识目录' },
      element('header', { class: 'note-tree-header' },
        element('div', {}, element('h2', { id: `${workspace.kind}-documents-heading` }, options.heading || '知识目录'), element('span', {}, `${workspaceDocuments.length} 篇文档`)),
        !readOnly ? actionButton('+', () => { void startBlankDocument(workspace, view.knowledgeBaseId || activeBases[0]?.id) }, 'ghost note-add-button', { 'aria-label': '新建文档', title: '新建文档' }) : null,
      ),
      element('div', { class: 'note-tree-search-wrap' }, interfaceIcon('search', 'search-symbol'), search),
      element('nav', { class: 'note-tree', 'data-scroll-key': `${workspace.kind}-note-tree` }, tree.length ? tree : element('div', { class: 'note-tree-empty' }, workspace.kind === 'session' && state.mountContext.sessionId ? '当前会话未挂载知识库' : '还没有知识库')),
      workspace.kind === 'session' ? element('footer', { class: 'note-tree-footer' }, actionButton('新建知识库', () => openKnowledgeBaseEditor(), 'ghost small')) : null,
    ),
    view.treeOpen ? element('button', {
      type: 'button', class: 'note-tree-scrim', 'aria-label': '关闭知识目录',
      onClick: () => { view.treeOpen = false; renderShell() },
    }) : null,
    renderNoteEditor(workspace, view.editor, selectedBase),
  )
}

function renderNoteEditor(workspace, editor, base) {
  const view = workspace.view
  const readOnly = documentWorkspaceReadOnly(workspace)
  if (!editor) return element('main', { class: 'note-editor note-editor-empty' },
    element('div', { class: 'note-empty-content' },
      element('span', { class: 'empty-document-mark', 'aria-hidden': 'true' }),
      element('h3', {}, '选择或新建一篇文档'),
      element('p', {}, readOnly ? '这个知识库已归档，当前只能阅读已有文档。' : '文档保存后会立即参与当前知识库的搜索与召回。'),
      !readOnly ? actionButton('新建文档', () => { void startBlankDocument(workspace, view.knowledgeBaseId || state.knowledgeBases.find(item => item.status === 'active')?.id) }, 'primary') : null,
    ))
  const saveShortcut = event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 's') {
      event.preventDefault()
      void saveDocumentEditor(workspace).then(saved => { if (saved) renderShell() })
    }
  }
  const update = (key, value) => {
    editor[key] = value
    editor.dirty = true
    editor.saveState = '未保存'
    updateEditorSaveState(editor.saveState)
  }
  const title = element('input', {
    class: 'note-title-input', value: editor.title, maxlength: 200, placeholder: '无标题文档', 'aria-label': '文档标题',
    onInput: event => update('title', event.target.value), onKeyDown: saveShortcut,
  })
  const body = element('textarea', {
    class: 'note-body-editor', maxlength: 50000, placeholder: '从这里开始记录…', 'aria-label': '文档正文',
    onInput: event => { update('body', event.target.value); resizeDocumentEditor(event.target) }, onKeyDown: saveShortcut,
  })
  body.value = editor.body
  const finalized = !editor.isNew && editor.documentState !== 'open'
  const mode = finalized || readOnly ? 'preview' : view.mode === 'edit' ? 'edit' : 'preview'
  if (mode === 'edit') window.requestAnimationFrame(() => resizeDocumentEditor(body))
  return element('main', { class: 'note-editor', 'aria-label': '文档编辑器' },
    element('header', { class: 'note-editor-toolbar' },
      element('div', { class: 'note-breadcrumb' },
        element('span', {}, base?.name || '知识库'),
        element('span', { 'aria-hidden': 'true' }, '/'),
        element('strong', {}, editor.isNew ? '新文档' : documentWorkspaceDocuments(workspace).find(item => item.id === editor.id)?.relPath || editor.title)),
      element('div', { class: 'note-editor-actions' },
        finalized ? badge(DOCUMENT_STATE_LABELS[editor.documentState] || '已结束', 'success') : readOnly ? badge('只读') : element('div', { class: 'note-mode-switch', role: 'tablist', 'aria-label': '文档视图' }, [
          ['edit', '编辑'],
          ['preview', '预览'],
        ].map(([value, label]) => element('button', {
          type: 'button', role: 'tab', 'aria-selected': String(mode === value),
          onClick: () => switchDocumentMode(workspace, value),
        }, label))),
        element('span', { class: 'editor-save-status', role: 'status' }, editor.saveState),
        finalized && !readOnly ? actionButton('重新打开', () => reopenDocument(workspace, editor), 'small') : null,
        !readOnly && !editor.isNew && !finalized ? actionButton('标记结束', () => openFinalizeDocument(workspace, editor), 'small') : null,
        !readOnly && !editor.isNew && !finalized ? actionButton('删除', () => confirmDeleteDocument(workspace, editor), 'ghost small') : null,
        !readOnly && !finalized ? actionButton(editor.isNew ? '创建文档' : '保存', () => { void saveDocumentEditor(workspace).then(saved => { if (saved) renderShell() }) }, 'primary small') : null,
      ),
    ),
    element('div', { class: 'note-editor-scroll', 'data-scroll-key': 'note-editor' },
      finalized ? element('aside', { class: 'document-finalized-banner', role: 'status' },
        element('strong', {}, DOCUMENT_STATE_LABELS[editor.documentState] || '文档已结束'),
        element('span', {}, editor.documentState === 'resolved'
          ? '这个问题已经解决，文档已封存并停止继续回写。'
          : '资料收集已经完成，文档已封存并停止继续回写。'),
        editor.finalizationNote ? element('p', {}, editor.finalizationNote) : null,
        editor.finalizedAt ? element('small', {}, `结束于 ${formatDate(editor.finalizedAt)}`) : null,
      ) : null,
      element('article', { class: `note-paper is-${mode}`, 'data-document-mode': mode },
        mode === 'edit' ? title : element('h1', { class: 'note-preview-title' }, editor.title || '无标题文档'),
        element('div', { class: 'note-document-meta' },
          element('span', {}, editor.isNew ? '尚未保存' : `更新于 ${formatDate(editor.updatedAt)}`),
          element('span', {}, editor.scope.kind === 'global' ? '全局知识' : `项目 · ${editor.scope.id}`)),
        mode === 'edit' ? body : renderMarkdownPreview(editor.body),
      ),
    ),
    element('footer', { class: 'note-inspector' },
      finalized || readOnly ? element('span', { class: 'note-format-hint' }, readOnly ? '知识库已归档 · 只读' : '只读封存 · 重新打开后才能编辑') : element('label', {}, element('span', {}, '类型'), element('select', {
        class: 'note-meta-select', onChange: event => update('type', event.target.value),
      }, TYPES.map(type => element('option', { value: type, selected: type === editor.type }, TYPE_LABELS[type])))),
      finalized || readOnly ? null : element('label', { class: 'note-tags-field' }, element('span', {}, '标签'), element('input', {
        value: editor.tagsText, placeholder: '用逗号分隔', onInput: event => update('tagsText', event.target.value),
      })),
      !finalized && !readOnly ? element('span', { class: 'note-format-hint' }, mode === 'edit' ? 'Markdown · Ctrl/⌘ S 保存' : 'Markdown 预览') : null,
    ),
  )
}

function switchDocumentMode(workspace, mode) {
  if (mode !== 'edit' && mode !== 'preview') return
  workspace.view.mode = mode
  renderShell()
  if (mode === 'edit') window.requestAnimationFrame(() => document.querySelector('.note-body-editor')?.focus())
}

function renderMarkdownPreview(markdown) {
  if (!markdown.trim()) return element('div', { class: 'markdown-preview is-empty', role: 'document' }, '暂无正文')
  const preview = element('div', { class: 'markdown-preview', role: 'document' })
  preview.innerHTML = window.DshKnowledgeMarkdown.renderMarkdown(markdown)
  preview.querySelectorAll('table').forEach(table => {
    const scroller = element('div', {
      class: 'markdown-table-scroll', role: 'region', tabindex: '0',
      'aria-label': '表格内容，可横向滚动',
    })
    table.replaceWith(scroller)
    scroller.append(table)
  })
  return preview
}

function resizeDocumentEditor(editor) {
  editor.style.height = 'auto'
  editor.style.height = `${Math.max(420, editor.scrollHeight)}px`
}

function openFinalizeDocument(workspace, editor) {
  const form = element('form', { class: 'form-grid' })
  const stateField = selectField('结束状态', [
    { value: 'resolved', label: '已解决 — 问题已有最终结论' },
    { value: 'complete', label: '已收集完成 — 资料不再补充' },
  ], 'resolved')
  const note = formField('结束说明（可选）', 'textarea', '', {
    maxlength: 1000,
    placeholder: '例如：生产环境验证通过，问题关闭。',
  })
  stateField.wrapper.classList.add('span-2')
  note.wrapper.classList.add('span-2')
  form.append(stateField.wrapper, note.wrapper)
  return openSheet({
    title: `结束“${editor.title}”`,
    description: '结束后文档仍可搜索和召回，但 AI 回写、候选审核和人工编辑都会被服务端拒绝；需要修改时必须先重新打开。',
    body: form,
    primaryLabel: '确认结束并封存',
    onPrimary: async () => {
      const saved = await api(`documents/${encodeURIComponent(editor.id)}/finalize`, {
        method: 'POST',
        body: { state: stateField.input.value, note: note.input.value.trim() },
      })
      workspace.view.editor = { ...saved, tagsText: saved.tags.join(', '), dirty: false, isNew: false, saveState: '已封存' }
      workspace.view.mode = 'preview'
      await reloadDocumentWorkspace(workspace)
      renderShell()
      showToast(stateField.input.value === 'resolved' ? '文档已标记为已解决并封存。' : '文档已标记为收集完成并封存。')
      return true
    },
  })
}

function reopenDocument(workspace, editor) {
  openConfirm({
    title: `重新打开“${editor.title}”？`,
    message: '重新打开后，人工编辑、AI 回写和候选审核将恢复。',
    confirmLabel: '确认重新打开',
    onConfirm: async () => {
      const saved = await api(`documents/${encodeURIComponent(editor.id)}/reopen`, { method: 'POST' })
      workspace.view.editor = { ...saved, tagsText: saved.tags.join(', '), dirty: false, isNew: false, saveState: '已重新打开' }
      await reloadDocumentWorkspace(workspace)
      renderShell()
      showToast('文档已重新打开。')
    },
  })
}

function confirmDeleteDocument(workspace, editor) {
  openConfirm({
    title: `删除“${editor.title}”？`,
    message: '文档和对应的召回知识会被永久删除，此操作无法撤销。',
    confirmLabel: '永久删除', danger: true,
    onConfirm: async () => {
      await api(`entries/${encodeURIComponent(editor.id)}`, { method: 'DELETE' })
      workspace.view.documentId = ''
      workspace.view.editor = null
      state.stats = null
      await reloadDocumentWorkspace(workspace)
      selectDefaultDocument(workspace)
      if (workspace.view.documentId) await loadDocumentEditor(workspace, workspace.view.documentId)
      renderShell()
      showToast('文档已删除。')
    },
  })
}

function renderCandidates() {
  const statuses = [['pending', '待审核'], ['approved', '已通过'], ['rejected', '已拒绝']]
  return element('section', { 'aria-labelledby': 'candidates-heading' },
    element('div', { class: 'section-heading' },
      element('div', {}, element('h2', { id: 'candidates-heading' }, 'AI 提取候选'), element('p', {}, '审核写入、模型推断、低置信度结果和冲突项会在这里等待确认；只有高置信度且证据明确的结果才能直接写入。')),
      element('div', { class: 'tabs', role: 'tablist', 'aria-label': '候选状态' }, statuses.map(([value, label]) => element('button', {
        type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(state.candidateStatus === value),
        onClick: async () => { state.candidateStatus = value; await navigate('candidates') },
      }, label, state.stats ? ` ${state.stats.candidates[value]}` : ''))),
    ),
    state.candidates.length ? element('div', { class: 'candidate-list' }, state.candidates.map(renderCandidateCard))
      : emptyState(`没有${STATUS_LABELS[state.candidateStatus]}候选`, state.candidateStatus === 'pending' ? '新的对话结束后，插件会在后台判断是否产生候选。' : '切换其他状态查看历史记录。'),
  )
}

function renderCandidateCard(candidate) {
  const pending = candidate.status === 'pending'
  const target = candidate.targetId ? state.candidateTargets.get(candidate.targetId) : null
  const targetAvailable = candidate.action === 'create' || Boolean(target)
  const action = candidatePrimaryAction(candidate)
  return element('article', { class: 'candidate' },
    element('div', { class: 'candidate-header' },
      element('div', {},
        element('div', {},
          badge(knowledgeBaseName(candidate.draft.knowledgeBaseId)), ' ',
          badge(ACTION_LABELS[candidate.action], candidate.action === 'conflict' ? 'warning' : 'accent'), ' ',
          badge(TYPE_LABELS[candidate.draft.type]), ' ',
          candidate.draft.source?.evidence ? badge(EVIDENCE_LABELS[candidate.draft.source.evidence] || candidate.draft.source.evidence) : null),
        element('h3', {}, candidate.draft.title),
      ),
      badge(STATUS_LABELS[candidate.status], candidate.status === 'approved' ? 'success' : candidate.status === 'rejected' ? 'danger' : 'warning'),
    ),
    element('div', { class: 'candidate-body' },
      renderCandidateDiff(candidate, target),
      element('div', { class: 'candidate-reason' },
        element('section', {},
          element('strong', {}, '写入位置'),
          element('span', { class: 'candidate-target' }, candidate.action === 'create'
            ? `创建“${candidate.draft.title}”`
            : target ? `合并到“${target.title}”` : `目标 ${candidate.targetId || '不可用'}`),
        ),
        renderCandidateMetadataChanges(candidate, target),
        element('section', {},
          element('strong', {}, '模型判断依据'),
          element('p', {}, candidate.reason || '未提供判断说明'),
        ),
        candidate.reviewNote ? element('section', {},
          element('strong', {}, '审核备注'),
          element('p', {}, candidate.reviewNote),
        ) : null,
      ),
    ),
    element('div', { class: 'candidate-footer' },
      element('small', {}, `${scopeLabel(candidate.draft.scope)} · 置信度 ${Math.round(candidate.draft.confidence * 100)}%${candidate.targetId ? ` · 目标 ${candidate.targetId}` : ''} · ${formatDate(candidate.createdAt)}`),
      pending ? element('div', { class: 'candidate-actions' },
        actionButton('拒绝', () => reviewCandidate(candidate, 'reject'), 'danger small'),
        actionButton(action.editLabel, () => openEntryEditor(undefined, candidate), 'small', {
          disabled: !targetAvailable,
          title: targetAvailable ? action.editLabel : '目标文档不可用，无法安全编辑合并结果',
        }),
        actionButton(action.label, () => reviewCandidate(candidate, 'approve', action.resolution), 'primary small', {
          disabled: !targetAvailable,
          title: targetAvailable ? action.label : '目标文档不可用，刷新后再审核',
        }),
      ) : null,
    ),
  )
}

function renderCandidateDiff(candidate, target) {
  if (candidate.action !== 'create' && !target) {
    return element('section', { class: 'candidate-change candidate-change-unavailable', role: 'alert' },
      element('strong', {}, '无法生成变更预览'),
      element('p', {}, '目标文档暂时不可用。为避免盲目覆盖，刷新并确认当前版本后再审核。'),
    )
  }
  const review = window.DshKnowledgeReview.createReviewChange(candidate.action, target?.body || '', candidate.draft.body)
  const title = candidate.action === 'create' ? '新文档内容' : candidate.action === 'conflict' ? '冲突合并预览' : '文档合并预览'
  const targetLabel = candidate.action === 'create'
    ? candidate.draft.title
    : `${target.title} · 当前版本 ${target.version}`
  return element('section', { class: `candidate-change is-${candidate.action}`, 'aria-label': title },
    element('div', { class: 'candidate-change-heading' },
      element('div', {}, element('strong', {}, title), element('small', {}, targetLabel)),
      element('div', { class: 'diff-summary', 'aria-label': `新增 ${review.diff.additions} 行，删除 ${review.diff.deletions} 行，未变更 ${review.diff.unchanged} 行` },
        element('span', { class: 'diff-stat additions' }, `+${review.diff.additions}`),
        element('span', { class: 'diff-stat deletions' }, `-${review.diff.deletions}`),
        element('span', { class: 'diff-stat unchanged' }, `${review.diff.unchanged} 未变`),
      ),
    ),
    review.diff.simplified ? element('div', { class: 'diff-notice' }, '文档变更较大，已使用简化差异视图。合并内容不受影响。') : null,
    element('div', { class: 'diff-viewer', role: 'table', 'aria-label': `${title}逐行差异` },
      element('div', { class: 'diff-column-headings', role: 'row' },
        element('span', { role: 'columnheader' }, '旧'),
        element('span', { role: 'columnheader' }, '新'),
        element('span', { 'aria-hidden': 'true' }),
        element('span', { role: 'columnheader' }, '正文'),
      ),
      review.displayLines.length
        ? review.displayLines.map(renderDiffLine)
        : element('div', { class: 'diff-empty' }, '正文为空，没有可写入的差异。'),
    ),
  )
}

function renderDiffLine(line) {
  if (line.kind === 'omitted') {
    return element('div', { class: 'diff-line is-omitted', role: 'row', 'aria-label': `${line.count} 行未变更，已折叠` },
      element('span', { class: 'diff-line-number', 'aria-hidden': 'true' }),
      element('span', { class: 'diff-line-number', 'aria-hidden': 'true' }),
      element('span', { class: 'diff-marker', 'aria-hidden': 'true' }, '…'),
      element('span', { class: 'diff-omitted-copy' }, `${line.count} 行未变更`),
    )
  }
  const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '
  const label = line.kind === 'add'
    ? `新增第 ${line.newLine} 行`
    : line.kind === 'remove' ? `删除原第 ${line.oldLine} 行` : `未变更行 ${line.oldLine}`
  return element('div', { class: `diff-line is-${line.kind}`, role: 'row', 'aria-label': label },
    element('span', { class: 'diff-line-number', role: 'cell' }, line.oldLine || ''),
    element('span', { class: 'diff-line-number', role: 'cell' }, line.newLine || ''),
    element('span', { class: 'diff-marker', role: 'cell', 'aria-hidden': 'true' }, marker),
    element('code', { class: 'diff-code', role: 'cell' }, line.text || ' '),
  )
}

function renderCandidateMetadataChanges(candidate, target) {
  if (!target || candidate.action === 'create') return null
  const changes = []
  if (target.title !== candidate.draft.title) changes.push(`标题：${target.title} → ${candidate.draft.title}`)
  const addedTags = candidate.draft.tags.filter(tag => !target.tags.includes(tag))
  if (addedTags.length) changes.push(`新增标签：${addedTags.join('、')}`)
  if (candidate.draft.confidence > target.confidence) {
    changes.push(`置信度：${Math.round(target.confidence * 100)}% → ${Math.round(candidate.draft.confidence * 100)}%`)
  }
  if (!changes.length) return null
  return element('section', { class: 'candidate-metadata' },
    element('strong', {}, '属性变化'),
    element('ul', {}, changes.map(change => element('li', {}, change))),
  )
}

function candidatePrimaryAction(candidate) {
  if (candidate.action === 'create') return { label: '写入新文档', editLabel: '编辑后写入' }
  if (candidate.action === 'conflict') return { label: '确认合并', editLabel: '编辑合并内容', resolution: 'merge' }
  return { label: '合并到文档', editLabel: '编辑后合并' }
}

function renderTokens() {
  const apiAddress = new URL(state.service.publicApiPrefix, location.origin).href.replace(/\/$/, '')
  return element('section', { 'aria-labelledby': 'tokens-heading' },
    element('div', { class: 'api-access-card' },
      element('div', { class: 'api-access-heading' },
        element('div', {}, element('strong', {}, '远程知识库 API'), element('p', {}, state.service.publicApiEnabled
          ? '其他 DSH 客户端可以使用下面的地址和客户端令牌连接。'
          : '当前仅能在本机管理；开启后其他 DSH 客户端才能连接。')),
        badge(state.service.publicApiEnabled ? '已开放' : '未开放', state.service.publicApiEnabled ? 'success' : 'warning'),
      ),
      element('label', { class: 'api-address-label', for: 'knowledge-public-api-address' }, '客户端填写的服务器地址'),
      element('div', { class: 'api-address-row' },
        Object.assign(element('input', { id: 'knowledge-public-api-address', class: 'input', readonly: true, value: apiAddress }), { value: apiAddress }),
        actionButton('复制地址', () => copyText(apiAddress, 'API 地址已复制。'), 'small'),
      ),
      element('div', { class: 'api-access-actions' },
        element('small', {}, state.service.publicApiEnabled ? '关闭后已有客户端会立即无法连接，本地管理不受影响。' : '开启远程 API 后，请为每台客户端创建独立令牌。'),
        actionButton(state.service.publicApiEnabled ? '关闭远程 API' : '开启远程 API', togglePublicApi, state.service.publicApiEnabled ? 'danger small' : 'primary small'),
      ),
    ),
    element('div', { class: 'section-heading' },
      element('div', {}, element('h2', { id: 'tokens-heading' }, '客户端访问令牌'), element('p', {}, '给其他 DSH 客户端分配最小必要权限；原始令牌只显示一次。')),
      actionButton('+ 创建令牌', openTokenCreator, 'primary'),
    ),
    element('div', { class: 'panel' }, element('div', { class: 'panel-body' },
      state.tokens.length ? element('div', { class: 'token-list' }, state.tokens.map(renderTokenRow)) : compactEmpty('还没有访问令牌'),
    )),
  )
}

function renderTokenRow(token) {
  const revoked = Boolean(token.revokedAt)
  return element('article', { class: 'token-row' },
    element('div', {},
      element('strong', {}, token.name, ' ', revoked ? badge('已撤销', 'danger') : badge('有效', 'success')),
      element('div', { class: 'permissions' }, token.permissions.map(permission => badge(permission))),
      element('small', {}, `创建于 ${formatDate(token.createdAt)}${token.lastUsedAt ? ` · 最近使用 ${formatDate(token.lastUsedAt)}` : ' · 尚未使用'}`),
    ),
    revoked
      ? actionButton('永久删除', () => confirmDeleteToken(token), 'danger small')
      : actionButton('撤销', () => confirmRevokeToken(token), 'danger small'),
  )
}

async function copyText(value, successMessage) {
  try { await navigator.clipboard.writeText(value); showToast(successMessage) } catch { showToast('复制失败，请手动选择内容。', 'error') }
}

function togglePublicApi() {
  const enabling = !state.service.publicApiEnabled
  openConfirm({
    title: enabling ? '开启远程知识库 API？' : '关闭远程知识库 API？',
    message: enabling
      ? '开启后，持有有效令牌的其他 DSH 客户端可以连接这台中央知识库。'
      : '关闭后，所有远程客户端会立即断开；本地知识库和管理台不受影响。',
    confirmLabel: enabling ? '确认开启' : '确认关闭', danger: !enabling,
    onConfirm: async () => {
      state.service = await api('service', { method: 'PUT', body: { publicApiEnabled: enabling } })
      showToast(enabling ? '远程 API 已开启。' : '远程 API 已关闭。')
      renderShell()
    },
  })
}

function emptyState(title, description, actionLabel, action) {
  return element('div', { class: 'empty-state' }, element('div', {}, element('strong', {}, title), element('p', {}, description), actionLabel ? actionButton(actionLabel, action, 'primary') : null))
}

function selectControl(label, options, current, onChange) {
  const select = element('select', { class: 'select', 'aria-label': label, onChange: (event) => onChange(event.target.value) },
    options.map(option => element('option', { value: option.value, selected: option.value === current }, option.label)))
  return select
}

function knowledgeBaseName(id) {
  return state.knowledgeBases.find(base => base.id === id)?.name || id || '默认知识库'
}

function parseTags(value) {
  return [...new Set(value.split(/[,，]/).map(tag => tag.trim().toLowerCase()).filter(Boolean))]
}

function openKnowledgeBaseEditor(base) {
  const source = base || { name: '', description: '', defaultTags: [], extractionInstructions: '', writebackPolicy: 'conservative' }
  const form = element('form', { class: 'form-grid' })
  const name = formField('名称', 'input', source.name, { required: true, maxlength: 100, placeholder: '例如：项目规范' })
  const description = formField('回写匹配描述', 'textarea', source.description, { maxlength: 2000, placeholder: '描述什么样的对话才属于这个库。例如：只记录 dsh-knowledge 项目的架构决策和部署规范' })
  const tags = formField('默认标签', 'input', source.defaultTags.join(', '), { placeholder: 'project-rule, backend' })
  const instructions = formField('提取要求', 'textarea', source.extractionInstructions, { maxlength: 4000, placeholder: '例如：只收录已确认、可跨会话复用的项目约定' })
  const policy = selectField('回写策略', [
    { value: 'conservative', label: '严谨（高置信度直写）' },
    { value: 'proactive', label: '主动（更积极沉淀）' },
  ], source.writebackPolicy || 'conservative')
  for (const field of [name, description, tags, instructions]) field.wrapper.classList.add('span-2')
  form.append(
    name.wrapper, description.wrapper, tags.wrapper, instructions.wrapper, policy.wrapper,
  )
  openSheet({
    title: base ? '编辑知识库' : '创建知识库',
    description: '匹配描述先判断对话是否属于该库；提取要求再规定应该收录什么。',
    body: form,
    primaryLabel: base ? '保存修改' : '创建',
    onPrimary: async () => {
      if (!form.reportValidity()) return false
      const draft = {
        name: name.input.value.trim(),
        description: description.input.value.trim(),
        defaultTags: parseTags(tags.input.value),
        extractionInstructions: instructions.input.value.trim(),
        writebackPolicy: policy.input.value,
      }
      if (base) await api(`knowledge-bases/${encodeURIComponent(base.id)}`, { method: 'PUT', body: { draft } })
      else await api('knowledge-bases', { method: 'POST', body: { draft } })
      showToast(base ? '知识库已更新。' : '知识库已创建，现在可以挂载到项目或会话。')
      await navigate('bases')
      return true
    },
  })
  name.input.focus()
}

function openBulkMountEditor() {
  const manager = state.mountManager
  const targetId = manager.targetKind === 'project' ? state.mountContext.projectId : state.mountContext.sessionId
  const bases = state.knowledgeBases.filter(base => base.status === 'active' && manager.selectedIds.has(base.id))
  if (!targetId || bases.length === 0) return
  const recall = element('input', { type: 'checkbox', checked: true })
  const writeMode = selectField('写入方式', [
    { value: 'none', label: '仅召回（不提取、不回写）' },
    { value: 'audit', label: '审核写入（推荐）' },
    { value: 'direct', label: '直接写入（普通结果自动生效；冲突仍待审）' },
  ], 'audit')
  const includeTags = formField('必须包含的标签', 'input', '', { placeholder: '可选，逗号分隔' })
  const excludeTags = formField('排除标签', 'input', '', { placeholder: '可选，逗号分隔' })
  const form = element('form', { class: 'form-grid' },
    element('div', { class: 'selection-summary span-2' },
      element('strong', {}, `将挂载 ${bases.length} 个知识库`),
      element('p', {}, bases.slice(0, 8).map(base => base.name).join('、'), bases.length > 8 ? ` 等 ${bases.length} 个` : ''),
    ),
    element('label', { class: 'check-option' }, recall, element('span', {}, element('strong', {}, '开启召回'), element('small', {}, '回答前检索所选知识库。'))),
    writeMode.wrapper,
    includeTags.wrapper,
    excludeTags.wrapper,
  )
  openSheet({
    title: `批量挂载到${manager.targetKind === 'project' ? '项目' : '会话'}`,
    description: targetId,
    body: form,
    primaryLabel: `挂载 ${bases.length} 个`,
    onPrimary: async () => {
      const include = parseTags(includeTags.input.value)
      const exclude = parseTags(excludeTags.input.value)
      if (include.some(tag => exclude.includes(tag))) {
        showToast('同一标签不能同时包含和排除。', 'error')
        return false
      }
      await api('mounts/bulk', { method: 'POST', body: {
        upserts: bases.map(base => ({
          targetKind: manager.targetKind,
          targetId,
          knowledgeBaseId: base.id,
          enabled: true,
          recallEnabled: recall.checked,
          writeMode: writeMode.input.value,
          includeTags: include,
          excludeTags: exclude,
          extractionInstructions: '',
        })),
        deleteIds: [],
      } })
      manager.selectedIds.clear()
      showToast(`已批量挂载 ${bases.length} 个知识库。`)
      await navigate('bases')
      return true
    },
  })
}

async function bulkRemoveMounts() {
  const manager = state.mountManager
  const targetId = manager.targetKind === 'project' ? state.mountContext.projectId : state.mountContext.sessionId
  const explicit = state.mounts.filter(mount =>
    mount.targetKind === manager.targetKind
    && mount.targetId === targetId
    && manager.selectedIds.has(mount.knowledgeBaseId))
  if (explicit.length === 0) {
    showToast(manager.targetKind === 'session' ? '所选知识库当前没有会话覆盖，无需恢复。' : '所选知识库当前没有项目挂载。')
    return
  }
  try {
    await api('mounts/bulk', { method: 'POST', body: { upserts: [], deleteIds: explicit.map(mount => mount.id) } })
    manager.selectedIds.clear()
    showToast(manager.targetKind === 'session' ? `已恢复 ${explicit.length} 个知识库的项目继承。` : `已取消 ${explicit.length} 个项目挂载。`)
    await navigate('bases')
  } catch (error) {
    showToast(friendlyError(error), 'error')
  }
}

function openMountEditor(base, targetKind, targetId, explicit, inherited) {
  const source = explicit || inherited || {
    enabled: true, recallEnabled: true, writeMode: 'audit', includeTags: [], excludeTags: [], extractionInstructions: '',
  }
  const enabled = element('input', { type: 'checkbox', checked: source.enabled })
  const recall = element('input', { type: 'checkbox', checked: source.recallEnabled })
  const writeMode = selectField('写入方式', [
    { value: 'none', label: '仅召回（不提取、不回写）' },
    { value: 'audit', label: '审核写入（先进待审核）' },
    { value: 'direct', label: '直接写入（普通结果自动生效；冲突仍待审）' },
  ], source.writeMode)
  const includeTags = formField('必须包含的标签', 'input', source.includeTags.join(', '), { placeholder: '例如：project-rule' })
  const excludeTags = formField('排除标签', 'input', source.excludeTags.join(', '), { placeholder: '例如：personal, temporary' })
  const instructions = formField('本挂载的额外提取要求', 'textarea', source.extractionInstructions, { maxlength: 4000, placeholder: '可以比知识库默认规则更严格' })
  const form = element('form', { class: 'form-grid' },
    element('label', { class: 'check-option span-2' }, enabled, element('span', {}, element('strong', {}, '启用这个挂载'), element('small', {}, '关闭后，当前范围不召回、不提取、不回写。'))),
    element('label', { class: 'check-option' }, recall, element('span', {}, element('strong', {}, '开启召回'), element('small', {}, '回答前只检索这个库。'))),
    writeMode.wrapper,
    includeTags.wrapper,
    excludeTags.wrapper,
    instructions.wrapper,
  )
  instructions.wrapper.classList.add('span-2')
  if (targetKind === 'session' && !explicit && inherited) {
    form.prepend(element('div', { class: 'context-warning span-2' }, '此会话目前继承项目配置。保存后会创建独立的会话覆盖。'))
  }
  if (explicit) {
    form.append(element('div', { class: 'mount-delete span-2' },
      element('span', { class: 'field-hint' }, targetKind === 'session' ? '删除会话覆盖后，将恢复继承项目配置。' : '删除后，该项目不再挂载此库。'),
      actionButton('删除当前配置', async () => {
        try {
          await api(`mounts/${encodeURIComponent(explicit.id)}`, { method: 'DELETE' })
          document.querySelector('.dialog-backdrop')?.remove()
          showToast(targetKind === 'session' ? '会话覆盖已删除，已恢复项目继承。' : '项目挂载已删除。')
          await navigate('bases')
        } catch (error) { showToast(friendlyError(error), 'error') }
      }, 'danger small'),
    ))
  }
  const updateAvailability = () => {
    for (const input of [recall, writeMode.input, includeTags.input, excludeTags.input, instructions.input]) input.disabled = !enabled.checked
  }
  enabled.addEventListener('change', updateAvailability)
  updateAvailability()
  openSheet({
    title: `${targetKind === 'project' ? '项目' : '会话'}挂载 · ${base.name}`,
    description: targetId,
    body: form,
    primaryLabel: '保存挂载',
    onPrimary: async () => {
      const include = parseTags(includeTags.input.value)
      const exclude = parseTags(excludeTags.input.value)
      if (include.some(tag => exclude.includes(tag))) {
        showToast('同一标签不能同时包含和排除。', 'error')
        return false
      }
      await api('mounts', { method: 'POST', body: { draft: {
        targetKind, targetId, knowledgeBaseId: base.id,
        enabled: enabled.checked,
        recallEnabled: enabled.checked && recall.checked,
        writeMode: enabled.checked ? writeMode.input.value : 'none',
        includeTags: include,
        excludeTags: exclude,
        extractionInstructions: instructions.input.value.trim(),
      } } })
      showToast(enabled.checked ? '挂载设置已保存。' : '已在当前范围关闭这个知识库。')
      await navigate('bases')
      return true
    },
  })
}

function confirmArchiveKnowledgeBase(base) {
  openConfirm({
    title: `归档“${base.name}”？`,
    message: '归档后所有挂载会自动关闭，其中的知识仍保留，但不再参与召回与回写。',
    confirmLabel: '确认归档', danger: true,
    onConfirm: async () => {
      await api(`knowledge-bases/${encodeURIComponent(base.id)}/archive`, { method: 'POST' })
      showToast('知识库已归档，相关挂载已关闭。')
      await navigate('bases')
    },
  })
}

function confirmRestoreKnowledgeBase(base) {
  openConfirm({
    title: `恢复“${base.name}”？`,
    message: '恢复后知识库可再次挂载；之前归档时关闭的挂载不会自动重开。',
    confirmLabel: '确认恢复', danger: false,
    onConfirm: async () => {
      await api(`knowledge-bases/${encodeURIComponent(base.id)}/restore`, { method: 'POST' })
      showToast('知识库已恢复，可以重新配置挂载。')
      await navigate('bases')
    },
  })
}

function confirmDeleteKnowledgeBase(base) {
  const confirmation = formField('输入知识库名称确认', 'input', '', {
    required: true, autocomplete: 'off', placeholder: base.name,
    'aria-describedby': 'delete-base-warning',
  })
  const form = element('form', {},
    element('div', { id: 'delete-base-warning', class: 'context-warning' },
      '此操作无法撤销。知识库中的全部知识、版本历史、候选、挂载和生成文档都会永久删除。'),
    confirmation.wrapper,
  )
  confirmation.wrapper.classList.add('delete-base-confirmation')
  openModal({
    title: `永久删除“${base.name}”？`,
    description: '只有已归档知识库可以永久删除。',
    body: form,
    primaryLabel: '永久删除',
    primaryVariant: 'danger',
    onPrimary: async () => {
      if (!form.reportValidity()) return false
      if (confirmation.input.value.trim() !== base.name) {
        showToast('输入的知识库名称不匹配。', 'error')
        confirmation.input.select()
        return false
      }
      await api(`knowledge-bases/${encodeURIComponent(base.id)}`, { method: 'DELETE' })
      if (state.documentView.knowledgeBaseId === base.id) {
        state.documentView.knowledgeBaseId = ''
        state.documentView.documentId = ''
      }
      if (state.libraryDetail.knowledgeBaseId === base.id) {
        state.libraryDetail.knowledgeBaseId = ''
        state.libraryDetail.documents = []
        state.libraryDetail.view = createDocumentViewState()
        state.knowledgeBaseView = 'libraries'
      }
      if (state.entryFilters.knowledgeBaseId === base.id) state.entryFilters.knowledgeBaseId = ''
      showToast('知识库及其全部关联数据已永久删除。')
      await navigate('bases')
      return true
    },
  })
  confirmation.input.focus()
}

function openEntryEditor(entry, candidate) {
  const activeWorkspace = activeDocumentWorkspace()
  const candidateTarget = candidate?.targetId ? state.candidateTargets.get(candidate.targetId) : null
  const candidateReview = candidate && (candidate.action === 'create' || candidateTarget)
    ? window.DshKnowledgeReview.createReviewChange(candidate.action, candidateTarget?.body || '', candidate.draft.body)
    : null
  const source = candidate ? { ...candidate.draft, body: candidateReview?.after || candidate.draft.body } : entry || {
    knowledgeBaseId: activeWorkspace?.view.knowledgeBaseId || undefined,
    title: '', body: '', type: 'fact', tags: [], scope: { kind: 'global' }, confidence: .8,
  }
  const form = element('form', { class: 'form-grid' })
  const title = formField('标题', 'input', source.title, { required: true, maxlength: 200, placeholder: '一句话说明这条知识' })
  const body = formField('正文', 'textarea', source.body, { required: true, maxlength: 50000, placeholder: '写下可在未来对话中复用的内容' })
  const type = selectField('类型', TYPES.map(value => ({ value, label: TYPE_LABELS[value] })), source.type)
  const activeBases = state.knowledgeBases.filter(base => base.status === 'active')
  const selectedBaseId = source.knowledgeBaseId || activeBases[0]?.id || 'default'
  const knowledgeBase = selectField('所属知识库', activeBases.map(base => ({ value: base.id, label: base.name })), selectedBaseId)
  const scope = selectField('范围', [{ value: 'global', label: '全局' }, { value: 'project', label: '项目' }], source.scope.kind)
  const project = formField('项目 ID / 路径', 'input', source.scope.kind === 'project' ? source.scope.id : '', { placeholder: '/workspace/project' })
  const tags = formField('标签', 'input', source.tags.join(', '), { placeholder: 'docker, deployment' })
  const confidenceInput = element('input', { type: 'range', min: 0, max: 1, step: .01, value: source.confidence })
  const confidenceValue = element('span', { class: 'range-value' }, `${Math.round(source.confidence * 100)}%`)
  confidenceInput.addEventListener('input', () => { confidenceValue.textContent = `${Math.round(Number(confidenceInput.value) * 100)}%` })
  const scopeProjectField = project.wrapper
  const updateScope = () => { scopeProjectField.hidden = scope.input.value !== 'project'; project.input.required = scope.input.value === 'project' }
  scope.input.addEventListener('change', updateScope)
  updateScope()
  form.append(
    title.wrapper,
    type.wrapper,
    knowledgeBase.wrapper,
    scope.wrapper,
    scopeProjectField,
    element('div', { class: 'field span-2' }, element('label', {}, '置信度'), element('div', { class: 'range-row' }, confidenceInput, confidenceValue)),
    body.wrapper,
    tags.wrapper,
  )
  body.wrapper.classList.add('span-2')
  tags.wrapper.classList.add('span-2')
  const modeTitle = candidate
    ? candidate.action === 'create' ? '编辑新文档' : '编辑合并内容'
    : entry ? '编辑知识文档' : '新建知识文档'
  const candidateDescription = candidate?.action === 'create'
    ? '确认后将创建文档并立即参与后续召回。'
    : '正文已载入完整合并预览；保存前可以处理重复内容或冲突。'
  const primaryLabel = candidate
    ? candidate.action === 'create' ? '写入新文档' : '保存并合并'
    : '保存文档'
  const modal = openSheet({ title: modeTitle, description: candidate ? candidateDescription : '文档保存后会立即参与后续召回。', body: form, primaryLabel, onPrimary: async () => {
    if (!form.reportValidity()) return false
    const draft = {
      knowledgeBaseId: knowledgeBase.input.value,
      title: title.input.value.trim(), body: body.input.value.trim(), type: type.input.value,
      tags: parseTags(tags.input.value),
      scope: scope.input.value === 'global' ? { kind: 'global' } : { kind: 'project', id: project.input.value.trim() },
      confidence: Number(confidenceInput.value),
      ...(source.source ? { source: source.source } : {}),
    }
    if (candidate) await api(`candidates/${encodeURIComponent(candidate.id)}/review`, {
      method: 'POST', body: { decision: 'approve', draft, ...(candidate.action === 'conflict' ? { resolution: 'merge' } : {}) },
    })
    else if (entry) await api(`entries/${encodeURIComponent(entry.id)}`, { method: 'PUT', body: { draft } })
    else await api('entries', { method: 'POST', body: { draft } })
    showToast(candidate ? candidate.action === 'create' ? '新文档已写入。' : '候选内容已合并。' : '知识已保存。')
    state.stats = null
    await navigate(candidate ? 'candidates' : state.view)
    return true
  } })
  title.input.focus()
  return modal
}

function formField(label, kind, value, attributes = {}) {
  const input = element(kind === 'textarea' ? 'textarea' : 'input', { class: kind === 'textarea' ? 'textarea' : 'input', value, ...attributes })
  if (kind === 'textarea') input.value = value
  return { input, wrapper: element('div', { class: 'field' }, element('label', {}, label), input) }
}

function selectField(label, options, value) {
  const input = element('select', { class: 'select' }, options.map(option => element('option', { value: option.value, selected: option.value === value }, option.label)))
  return { input, wrapper: element('div', { class: 'field' }, element('label', {}, label), input) }
}

async function loadModelCatalog() {
  if (state.modelCatalog !== null) return state.modelCatalog
  try {
    const response = await fetch('/knowledge-control/v1/models', { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    state.modelCatalog = Array.isArray(payload.providers) ? payload.providers : []
  } catch (error) {
    state.modelCatalog = []
    showToast(`无法读取当前 DSH 的模型目录：${error instanceof Error ? error.message : String(error)}`, 'error')
  }
  return state.modelCatalog
}

function modelRouteFields(currentProvider, currentModel) {
  const providers = [...(state.modelCatalog || [])]
  if (currentProvider && !providers.some(item => item.id === currentProvider)) {
    providers.push({ id: currentProvider, name: `${currentProvider}（当前配置）`, models: [] })
  }
  const provider = selectField('模型提供方', providers.map(item => ({ value: item.id, label: item.name || item.id })), currentProvider || providers[0]?.id || '')
  const model = selectField('回写模型', [], '')
  const refreshModels = preferred => {
    const selected = providers.find(item => item.id === provider.input.value)
    const models = [...(selected?.models || [])]
    if (preferred && !models.some(item => item.id === preferred)) models.push({ id: preferred, name: `${preferred}（当前配置）` })
    model.input.replaceChildren(...models.map(item => element('option', {
      value: item.id, selected: item.id === preferred,
    }, item.name && item.name !== item.id ? `${item.name} · ${item.id}` : item.id)))
    if (preferred && models.some(item => item.id === preferred)) model.input.value = preferred
  }
  provider.input.addEventListener('change', () => refreshModels(''))
  refreshModels(currentModel)
  return { provider, model }
}

async function reviewCandidate(candidate, decision, resolution) {
  const approve = decision === 'approve'
  const action = candidatePrimaryAction(candidate)
  const title = approve ? `${action.label}？` : '拒绝这条候选？'
  const message = !approve
    ? '拒绝后会保留审核记录，但不会进入知识库。'
    : candidate.action === 'create'
      ? '确认后将创建新文档，并立即参与后续对话召回。'
      : candidate.action === 'conflict'
        ? '确认后将保留当前文档内容，并把候选内容合入同一文档。'
        : '确认后将按预览结果合入目标文档；若审核期间文档发生变化，会转为冲突项。'
  openConfirm({
    title,
    message,
    confirmLabel: approve ? action.label : '确认拒绝', danger: !approve,
    onConfirm: async () => {
      const reviewed = await api(`candidates/${encodeURIComponent(candidate.id)}/review`, {
        method: 'POST', body: { decision, ...(resolution ? { resolution } : {}) },
      })
      if (approve && reviewed.status === 'pending' && reviewed.action === 'conflict') {
        showToast('审核期间知识已变化，候选已转为冲突项，请比较后重新确认。')
        state.stats = null
        await navigate('candidates')
        return
      }
      showToast(approve ? candidate.action === 'create' ? '新文档已写入。' : '候选内容已合并。' : '候选已拒绝。')
      state.stats = null
      await navigate('candidates')
    },
  })
}

function confirmArchive(entry) {
  openConfirm({ title: '归档这条知识？', message: '归档后它不会再参与召回，版本历史仍会保留。', confirmLabel: '确认归档', danger: true, onConfirm: async () => {
    await api(`entries/${encodeURIComponent(entry.id)}/archive`, { method: 'POST' })
    showToast('知识已归档。')
    state.stats = null
    await navigate('entries')
  } })
}

function confirmDelete(entry) {
  openConfirm({ title: '彻底删除这条知识？', message: '知识正文和全部版本历史都会永久删除，此操作无法撤销。', confirmLabel: '永久删除', danger: true, onConfirm: async () => {
    await api(`entries/${encodeURIComponent(entry.id)}`, { method: 'DELETE' })
    showToast('知识已彻底删除。')
    state.stats = null
    await navigate('entries')
  } })
}

async function openHistory(entry) {
  try {
    const versions = await api(`entries/${encodeURIComponent(entry.id)}/versions`)
    const content = element('div', { class: 'history' }, versions.map(version => element('article', { class: 'history-item' },
      element('div', { class: 'history-line' }, element('span', { class: 'history-dot', 'aria-hidden': 'true' })),
      element('div', { class: 'history-content' }, element('strong', {}, `v${version.version} · ${CHANGE_LABELS[version.changeKind]}`), element('small', {}, formatDate(version.createdAt)), element('p', {}, version.snapshot.body)),
    )))
    openModal({ title: `${entry.title} · 版本历史`, description: '每次修改都会保留不可变快照。', body: content, cancelLabel: '关闭' })
  } catch (error) { showToast(friendlyError(error), 'error') }
}

function openTokenCreator() {
  const name = formField('令牌名称', 'input', '', { required: true, maxlength: 100, placeholder: '例如：办公室电脑' })
  const permissions = ['read', 'propose', 'write', 'admin']
  const checkboxes = permissions.map((permission, index) => {
    const input = element('input', { type: 'checkbox', value: permission, checked: index === 0 })
    return { permission, input, node: element('label', { class: 'check-option' }, input, permission) }
  })
  const body = element('form', { class: 'form-grid' }, name.wrapper,
    element('div', { class: 'field span-2' }, element('label', {}, '权限'), element('div', { class: 'check-grid' }, checkboxes.map(item => item.node)), element('span', { class: 'field-hint' }, '普通客户端建议只授予 read + propose。')))
  name.wrapper.classList.add('span-2')
  openModal({ title: '创建客户端令牌', description: '原始令牌只会在创建成功后显示一次。', body, primaryLabel: '创建令牌', onPrimary: async () => {
    if (!body.reportValidity()) return false
    const selected = checkboxes.filter(item => item.input.checked).map(item => item.permission)
    if (!selected.length) { showToast('请至少选择一项权限。', 'error'); return false }
    const created = await api('tokens', { method: 'POST', body: { name: name.input.value.trim(), permissions: selected } })
    await loadTokens()
    renderShell()
    window.setTimeout(() => showSecret(created.token), 0)
    return true
  } })
  name.input.focus()
}

function showSecret(token) {
  const code = element('code', {}, token)
  const content = element('div', { class: 'secret-box' }, element('strong', {}, '请立即复制并妥善保存'), element('p', {}, '关闭此窗口后，服务端无法再次显示原始令牌。'), element('div', { class: 'secret-value' }, code, actionButton('复制', async () => {
    try { await navigator.clipboard.writeText(token); showToast('令牌已复制。') } catch { showToast('复制失败，请手动选择令牌。', 'error') }
  }, 'small')))
  openModal({ title: '令牌创建成功', body: content, cancelLabel: '我已保存' })
}

function confirmRevokeToken(token) {
  openConfirm({ title: `撤销“${token.name}”？`, message: '使用此令牌的客户端会立即失去访问权限，此操作不可撤销。', confirmLabel: '确认撤销', danger: true, onConfirm: async () => {
    await api(`tokens/${encodeURIComponent(token.id)}`, { method: 'DELETE' })
    showToast('令牌已撤销。')
    await loadTokens()
    renderShell()
  } })
}

function confirmDeleteToken(token) {
  openConfirm({ title: `永久删除“${token.name}”？`, message: '这条已撤销令牌记录会被永久删除，此操作无法撤销。', confirmLabel: '永久删除', danger: true, onConfirm: async () => {
    await api(`tokens/${encodeURIComponent(token.id)}`, { method: 'DELETE' })
    showToast('已撤销令牌已永久删除。')
    await loadTokens()
    renderShell()
  } })
}

function openConfirm({ title, message, confirmLabel, danger, onConfirm }) {
  return openModal({ title, body: element('p', {}, message), primaryLabel: confirmLabel, primaryVariant: danger ? 'danger' : 'primary', onPrimary: async () => { await onConfirm(); return true } })
}

function openSheet(options) {
  return openModal({ ...options, presentation: 'sheet' })
}

function openModal({ title, description = '', body, primaryLabel, primaryVariant = 'primary', onPrimary, cancelLabel = '取消', presentation = 'modal' }) {
  const previouslyFocused = document.activeElement
  const isSheet = presentation === 'sheet'
  const backdrop = element('div', { class: `dialog-backdrop${isSheet ? ' sheet-backdrop' : ''}` })
  const dialog = element('section', { class: `dialog${isSheet ? ' sheet' : ''} ${primaryLabel ? '' : 'narrow'}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title' })
  let busy = false
  const close = () => {
    if (busy) return
    document.removeEventListener('keydown', onKeyDown)
    backdrop.remove()
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
  }
  const closeButton = actionButton('×', close, 'ghost', { 'aria-label': '关闭对话框' })
  const cancel = actionButton(cancelLabel, close)
  const primary = primaryLabel ? actionButton(primaryLabel, async () => {
    if (busy) return
    busy = true
    primary.disabled = true
    cancel.disabled = true
    const original = primary.textContent
    primary.textContent = '正在处理…'
    try {
      const shouldClose = await onPrimary()
      busy = false
      if (shouldClose !== false) close()
      else { primary.disabled = false; cancel.disabled = false; primary.textContent = original }
    } catch (error) {
      busy = false
      primary.disabled = false
      cancel.disabled = false
      primary.textContent = original
      showToast(friendlyError(error), 'error')
    }
  }, primaryVariant) : null
  const onKeyDown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close() }
    if (event.key === 'Tab') trapFocus(event, dialog)
  }
  dialog.append(
    element('header', { class: 'dialog-header' }, element('div', {}, element('h2', { id: 'dialog-title' }, title), description ? element('p', {}, description) : null), closeButton),
    element('div', { class: 'dialog-body' }, body),
    element('footer', { class: 'dialog-footer' }, cancel, primary),
  )
  backdrop.append(dialog)
  backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) close() })
  document.body.append(backdrop)
  document.addEventListener('keydown', onKeyDown)
  window.setTimeout(() => (dialog.querySelector('input, textarea, select, button') || dialog).focus(), 0)
  return { close, dialog }
}

function trapFocus(event, container) {
  const focusable = [...container.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}

function formatDate(value) {
  try { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) } catch { return value }
}

function scopeLabel(scope) {
  return scope.kind === 'global' ? '全局' : `项目 · ${scope.id}`
}

function friendlyError(error) {
  if (error.status === 403) return '当前令牌没有执行此操作所需的权限。'
  if (error.status === 409) return error.message || '内容已发生变化，请刷新后重试。'
  if (error.name === 'AbortError') return '请求已取消。'
  return error.message || '操作失败，请稍后重试。'
}

void installHostThemeBridge().then(() => boot())
