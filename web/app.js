const API_BASE = document.querySelector('meta[name="dsh-knowledge-api"]')?.content || '/knowledge-api/v1'
const AUTH_MODE = document.querySelector('meta[name="dsh-knowledge-auth-mode"]')?.content || 'bearer'
const WEB_PATH = document.querySelector('meta[name="dsh-knowledge-web"]')?.content || '/knowledge'
const ASSET_VERSION = document.querySelector('meta[name="dsh-knowledge-asset-version"]')?.content || ''
const moduleUrl = name => `./${name}.js${ASSET_VERSION ? `?v=${encodeURIComponent(ASSET_VERSION)}` : ''}`
const [apiModule, themeModule, uiModule] = await Promise.all([
  import(moduleUrl('api-client')),
  import(moduleUrl('host-theme')),
  import(moduleUrl('ui-primitives')),
])
const { createApiClient } = apiModule
const { installHostThemeBridge } = themeModule
const { actionButton, badge, createToastPresenter, element, interfaceIcon, paneToggleButton } = uiModule
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
const KNOWLEDGE_DOCUMENT_DRAG_TYPE = 'application/x-dsh-knowledge-document-id'
const NOTE_MAX_FILE_SIZE = 64 * 1024 * 1024
const pageParams = new URLSearchParams(location.search)
const initialKnowledgeBaseId = pageParams.get('knowledgeBaseId')?.trim() || ''
const initialDocumentId = pageParams.get('documentId')?.trim() || ''
const mountContext = {
  sessionId: pageParams.get('sessionId')?.trim() || '',
  projectId: pageParams.get('projectId')?.trim() || '',
}
const app = document.querySelector('#app')
const toastRegion = document.querySelector('#toast-region')
const showToast = createToastPresenter(toastRegion)
const savedDocumentLayout = readDocumentLayout()

function createDocumentViewState(overrides = {}) {
  return {
    knowledgeBaseId: '', documentId: '', query: '', mode: 'preview', treeOpen: false,
    expandedBases: new Set(), documentPages: new Map(),
    searchResults: [], searchNextCursor: '', searchTotal: 0, searchLoading: false, searchError: '', searchRequest: 0,
    editor: null, editorLoading: false, loadingDocumentId: '', ...overrides,
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
    knowledgeBaseId: initialKnowledgeBaseId,
    documentId: initialDocumentId,
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
  candidateBatchRunning: false,
  settings: { writebackPolicy: 'conservative', updatedAt: '' },
  modelCatalog: null,
  settingsSaving: false,
  tokens: [],
  notes: {
    children: new Map(), loadedFolders: new Set(), expandedFolders: new Set(),
    selectedId: '', selectedNode: null, currentFolderId: null, breadcrumbs: [],
    content: '', draft: '', dirty: false, assetUrl: '', query: '', searchResults: [],
    transfer: null, loadingNodeId: '',
  },
  service: { publicApiEnabled: false, publicApiPrefix: '/knowledge-api/v1', remote: false },
  scrollPositions: new Map(),
  loading: false,
  loadingPhase: '',
  loadingProgress: 0,
  error: '',
}

let scrollRestoreFrame = 0
let navigationController = null
let navigationRequest = 0
let navigationSave = Promise.resolve(true)
let libraryDetailRequest = 0
let documentSearchTimer = 0
let documentSearchController = null
let noteSearchTimer = 0
let noteSearchController = null
let noteSearchRequest = 0
let markdownEditorHandle = null
let noteEditorLoader = null
let markdownEditorMountRequest = 0
let plainTextEditorHandle = null
let plainTextEditorMountRequest = 0
let noteTransferFrame = 0
let noteTransferSequence = 0
let noteSelectionRequest = 0
let knowledgeDocumentDrag = null
let movingDocumentId = ''

function readDocumentLayout() {
  const fallback = {
    sidebarHidden: false,
    sidebarWidth: 214,
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

function refreshWorkspaceEffects(root = document) {
  window.DshKnowledgeEffects?.refresh(root)
}

const { api, binaryRequest, binaryUploadRequest } = createApiClient({
  apiBase: API_BASE,
  authMode: AUTH_MODE,
  getToken: () => state.token,
})

async function boot() {
  if (AUTH_MODE === 'same-origin') {
    state.token = ''
    await Promise.all([
      api('service').then(service => { state.service = service }).catch(() => {}),
      navigate('entries'),
    ])
    renderShell()
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
  refreshWorkspaceEffects(app)
}

function signOut() {
  cancelPendingSearches()
  releaseNoteEditors()
  releaseNoteAsset()
  sessionStorage.removeItem(TOKEN_KEY)
  Object.assign(state, { token: '', stats: null, overview: null, knowledgeBases: [], mounts: [], resolvedMounts: [], entries: [], documents: [], candidates: [], candidateTargets: new Map(), settings: { writebackPolicy: 'conservative', updatedAt: '' }, tokens: [] })
  state.notes = { children: new Map(), loadedFolders: new Set(), expandedFolders: new Set(), selectedId: '', selectedNode: null, currentFolderId: null, breadcrumbs: [], content: '', draft: '', dirty: false, assetUrl: '', query: '', searchResults: [], transfer: null, loadingNodeId: '' }
  if (AUTH_MODE === 'same-origin') void boot()
  else renderLogin()
}

async function navigate(view) {
  const request = ++navigationRequest
  navigationSave = navigationSave.then(() => saveBeforeNavigation(), () => saveBeforeNavigation())
  if (!await navigationSave || request !== navigationRequest) return
  cancelPendingSearches()
  navigationController?.abort()
  const controller = new AbortController()
  navigationController = controller
  const previousView = state.view
  if (view === 'bases' && previousView !== 'bases' && state.knowledgeBaseView === 'detail') {
    state.knowledgeBaseView = 'libraries'
  }
  state.view = view
  state.menuOpen = false
  state.loading = true
  state.loadingPhase = loadingPhaseForView(view)
  state.loadingProgress = .12
  state.error = ''
  renderShell()
  try {
    if (view === 'overview') await loadOverview(controller.signal)
    if (view === 'bases') await loadKnowledgeBasesPage(controller.signal)
    if (view === 'entries') await loadDocuments(controller.signal, (label, progress) => updateLoadingPhase(request, label, progress))
    if (view === 'candidates') await loadCandidates(controller.signal)
    if (view === 'notes') await loadNotes(controller.signal, (label, progress) => updateLoadingPhase(request, label, progress))
    if (view === 'tokens') await loadTokens(controller.signal)
  } catch (error) {
    if (controller.signal.aborted) return
    if (error.status === 401 && AUTH_MODE === 'bearer') return signOut()
    state.error = friendlyError(error)
  } finally {
    if (navigationController !== controller) return
    state.loading = false
    state.loadingPhase = ''
    state.loadingProgress = 1
    renderShell()
  }
}

function cancelPendingSearches() {
  state.documentView.searchRequest += 1
  state.libraryDetail.view.searchRequest += 1
  noteSearchRequest += 1
  window.clearTimeout(documentSearchTimer)
  window.clearTimeout(noteSearchTimer)
  documentSearchController?.abort()
  noteSearchController?.abort()
  documentSearchController = null
  noteSearchController = null
  documentSearchTimer = 0
  noteSearchTimer = 0
}

function loadingPhaseForView(view) {
  return ({
    overview: '正在汇总知识活动', bases: '正在读取知识库配置', entries: '正在读取知识目录',
    notes: '正在读取笔记目录', candidates: '正在准备审核队列', tokens: '正在读取访问权限',
  })[view] || '正在准备工作区'
}

function updateLoadingPhase(request, label, progress) {
  if (request !== navigationRequest || !state.loading) return
  state.loadingPhase = label
  state.loadingProgress = Math.max(0, Math.min(1, progress))
  renderShell()
}

async function saveBeforeNavigation() {
  if (state.view === 'notes' && state.notes.dirty) return saveNoteDocument()
  return saveBeforeLeavingDocument()
}

async function saveBeforeLeavingDocument() {
  const workspace = activeDocumentWorkspace()
  const editor = workspace?.view.editor
  if (!workspace || !editor?.dirty) return true
  const emptyDraft = editor.isNew && !editor.title.trim() && !editor.body.trim()
  if (emptyDraft) {
    workspace.view.editor = null
    workspace.view.documentId = ''
    return true
  }
  return saveDocumentEditor(workspace)
}

async function refreshStats(signal) {
  state.stats = await api('stats', { signal })
}

async function ensureKnowledgeBases(force = false, signal) {
  if (force || state.knowledgeBases.length === 0) state.knowledgeBases = await api('knowledge-bases', { signal })
  return state.knowledgeBases
}

async function loadKnowledgeBasesPage(signal) {
  const options = { signal }
  const requests = [api('knowledge-bases', options), api('mounts', options), api('settings', options), api('service', options)]
  if (state.mountContext.sessionId) {
    const params = new URLSearchParams({ sessionId: state.mountContext.sessionId })
    if (state.mountContext.projectId) params.set('projectId', state.mountContext.projectId)
    requests.push(api(`mounts/resolve?${params}`, options))
  }
  const [bases, mounts, settings, service, resolved = []] = await Promise.all(requests)
  state.knowledgeBases = bases
  state.mounts = mounts
  state.settings = settings
  state.service = service
  state.resolvedMounts = resolved
  await refreshStats(signal)
}

async function loadOverview(signal) {
  const options = { signal }
  const [stats, recent, pending, bases] = await Promise.all([
    api('stats', options),
    api('entries?status=active&limit=6', options),
    api('candidates?status=pending&limit=5', options),
    api('knowledge-bases', options),
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

async function loadDocuments(signal, onPhase = () => {}) {
  onPhase('正在读取可用知识库', .24)
  const options = { signal }
  const requests = [api('knowledge-bases', options)]
  if (state.mountContext.sessionId) {
    const params = new URLSearchParams({ sessionId: state.mountContext.sessionId })
    if (state.mountContext.projectId) params.set('projectId', state.mountContext.projectId)
    requests.push(api(`mounts/resolve?${params}`, options))
  }
  const [results, stats] = await Promise.all([
    Promise.all(requests),
    state.stats ? Promise.resolve(state.stats) : api('stats', options),
  ])
  const [bases, resolved = []] = results
  state.knowledgeBases = bases
  state.resolvedMounts = resolved
  state.stats = stats
  onPhase('正在建立文档索引', .56)
  const visibleBaseIds = new Set(documentKnowledgeBases(bases).map(base => base.id))
  state.documents = state.documents.filter(document => visibleBaseIds.has(document.knowledgeBaseId))
  const workspace = sessionDocumentWorkspace()
  const view = workspace.view
  const availableBaseIds = visibleBaseIds
  if (!view.knowledgeBaseId || !availableBaseIds.has(view.knowledgeBaseId)) {
    view.knowledgeBaseId = state.entryFilters.knowledgeBaseId && availableBaseIds.has(state.entryFilters.knowledgeBaseId)
      ? state.entryFilters.knowledgeBaseId
      : documentKnowledgeBases(bases)[0]?.id || ''
  }
  if (view.knowledgeBaseId) {
    view.expandedBases.add(view.knowledgeBaseId)
    await loadDocumentPage(workspace, view.knowledgeBaseId, { signal })
  }
  if (view.documentId && !state.documents.some(document => document.id === view.documentId)) {
    try {
      const document = await api(`documents/${encodeURIComponent(view.documentId)}`, { signal })
      if (visibleBaseIds.has(document.knowledgeBaseId)) {
        view.knowledgeBaseId = document.knowledgeBaseId
        view.expandedBases.add(document.knowledgeBaseId)
        mergeDocumentSummaries(workspace, [documentSummary(document)], document.knowledgeBaseId, false)
      } else view.documentId = ''
    } catch (error) {
      if (error.name === 'AbortError') throw error
      view.documentId = ''
    }
  }
  selectDefaultDocument(workspace)
  if (view.documentId) {
    onPhase('正在打开最近文档', .82)
    await loadDocumentEditor(workspace, view.documentId, signal)
  }
  else view.editor = null
}

async function loadNotes(signal, onPhase = () => {}) {
  onPhase('正在读取顶层目录', .36)
  state.notes.children.set('root', await api('notes?limit=500', { signal }))
  state.notes.loadedFolders.add('root')
  if (state.notes.selectedId) {
    onPhase('正在恢复上次打开的笔记', .74)
    const selected = state.notes.selectedNode?.id === state.notes.selectedId
      ? state.notes.selectedNode
      : await api(`notes/${encodeURIComponent(state.notes.selectedId)}`, { signal }).catch(() => null)
    if (!selected) clearNoteSelection()
    else state.notes.selectedNode = selected
  }
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

function documentPageState(workspace, knowledgeBaseId) {
  const pages = workspace.view.documentPages
  if (!pages.has(knowledgeBaseId)) {
    pages.set(knowledgeBaseId, { loaded: false, loading: false, nextCursor: '', total: 0, error: '' })
  }
  return pages.get(knowledgeBaseId)
}

function mergeDocumentSummaries(workspace, items, knowledgeBaseId, reset) {
  const current = documentWorkspaceDocuments(workspace)
  const retained = reset ? current.filter(document => document.knowledgeBaseId !== knowledgeBaseId) : current
  const merged = new Map(retained.map(document => [document.id, document]))
  for (const item of items) merged.set(item.id, item)
  setDocumentWorkspaceDocuments(workspace, [...merged.values()])
}

async function loadDocumentPage(workspace, knowledgeBaseId, options = {}) {
  if (!knowledgeBaseId) return
  const page = documentPageState(workspace, knowledgeBaseId)
  if (page.loading || (!options.reset && !options.append && page.loaded)) return
  if (options.append && !page.nextCursor) return
  page.loading = true
  page.error = ''
  const cursor = options.append ? page.nextCursor : ''
  try {
    const params = new URLSearchParams({ knowledgeBaseId, limit: '60' })
    if (cursor) params.set('cursor', cursor)
    const result = await api(`document-index?${params}`, { signal: options.signal })
    mergeDocumentSummaries(workspace, result.items, knowledgeBaseId, !options.append)
    page.loaded = true
    page.nextCursor = result.nextCursor || ''
    page.total = result.total
  } catch (error) {
    if (error.name === 'AbortError') throw error
    page.error = friendlyError(error)
    if (options.throwOnError) throw error
  } finally {
    page.loading = false
  }
}

async function toggleDocumentBase(workspace, baseId) {
  const view = workspace.view
  view.knowledgeBaseId = baseId
  if (view.expandedBases.has(baseId)) {
    view.expandedBases.delete(baseId)
    renderShell()
    return
  }
  view.expandedBases.add(baseId)
  const page = documentPageState(workspace, baseId)
  if (!page.loaded) page.loading = true
  renderShell()
  if (!page.loaded) {
    page.loading = false
    await loadDocumentPage(workspace, baseId)
    renderShell()
  }
}

function resetDocumentSearch(view) {
  view.searchRequest += 1
  view.searchResults = []
  view.searchNextCursor = ''
  view.searchTotal = 0
  view.searchLoading = false
  view.searchError = ''
}

function scheduleDocumentSearch(workspace) {
  window.clearTimeout(documentSearchTimer)
  documentSearchController?.abort()
  documentSearchController = null
  const view = workspace.view
  view.searchRequest += 1
  if (!view.query.trim()) {
    resetDocumentSearch(view)
    renderShell()
    return
  }
  view.searchLoading = true
  view.searchError = ''
  documentSearchTimer = window.setTimeout(() => { void loadDocumentSearch(workspace, true) }, 220)
}

function renderDocumentSearchState(workspace) {
  renderShell()
  window.requestAnimationFrame(() => {
    const input = document.querySelector(`.note-tree-search[data-document-scope="${workspace.kind}"]`)
    input?.focus()
    input?.setSelectionRange(input.value.length, input.value.length)
  })
}

async function loadDocumentSearch(workspace, reset = false) {
  const view = workspace.view
  const query = view.query.trim()
  if (!query) return resetDocumentSearch(view)
  const request = ++view.searchRequest
  documentSearchController?.abort()
  const controller = new AbortController()
  documentSearchController = controller
  view.searchLoading = true
  view.searchError = ''
  const params = new URLSearchParams({ q: query, limit: '80' })
  const bases = documentWorkspaceBases(workspace)
  if (bases.length === 0) {
    resetDocumentSearch(view)
    return renderShell()
  }
  if (workspace.kind === 'library') {
    params.append('knowledgeBaseId', state.libraryDetail.knowledgeBaseId)
  } else if (state.mountContext.sessionId) {
    params.set('sessionId', state.mountContext.sessionId)
    if (state.mountContext.projectId) params.set('projectId', state.mountContext.projectId)
  } else {
    params.set('active', '1')
  }
  if (!reset && view.searchNextCursor) params.set('cursor', view.searchNextCursor)
  try {
    const result = await api(`document-index?${params}`, { signal: controller.signal })
    if (request !== view.searchRequest || query !== view.query.trim()) return
    const merged = new Map((reset ? [] : view.searchResults).map(document => [document.id, document]))
    for (const item of result.items) merged.set(item.id, item)
    view.searchResults = [...merged.values()]
    view.searchNextCursor = result.nextCursor || ''
    view.searchTotal = result.total
  } catch (error) {
    if (controller.signal.aborted) return
    if (request !== view.searchRequest) return
    view.searchError = friendlyError(error)
  } finally {
    if (documentSearchController === controller) documentSearchController = null
    if (request === view.searchRequest) {
      view.searchLoading = false
      renderDocumentSearchState(workspace)
    }
  }
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
  const baseId = workspace.kind === 'library' ? state.libraryDetail.knowledgeBaseId : workspace.view.knowledgeBaseId
  if (!baseId) return true
  await loadDocumentPage(workspace, baseId, { reset: true, throwOnError: true })
  if (workspace.kind === 'library' && state.libraryDetail.knowledgeBaseId !== baseId) return false
  const selectedId = workspace.view.documentId
  if (selectedId && !documentWorkspaceDocuments(workspace).some(document => document.id === selectedId)) {
    const document = await api(`documents/${encodeURIComponent(selectedId)}`)
    mergeDocumentSummaries(workspace, [documentSummary(document)], baseId, false)
  }
  return true
}

function documentSummary(document) {
  const { content: _content, ...summary } = document
  return summary
}

function selectDefaultDocument(workspace) {
  const view = workspace.view
  const documents = documentWorkspaceDocuments(workspace).filter(document => document.knowledgeBaseId === view.knowledgeBaseId)
  if (!documents.some(document => document.id === view.documentId)) {
    view.documentId = documents[0]?.id || ''
  }
  if (view.knowledgeBaseId) view.expandedBases.add(view.knowledgeBaseId)
}

async function loadDocumentEditor(workspace, id, signal) {
  const revision = (workspace.view.loadRevision || 0) + 1
  workspace.view.loadRevision = revision
  const [entry, noteReferences] = await Promise.all([
    api(`entries/${encodeURIComponent(id)}`, { signal }),
    api(`entries/${encodeURIComponent(id)}/note-references`, { signal }),
  ])
  if (workspace.view.loadRevision !== revision || workspace.view.documentId !== id) return false
  workspace.view.mode = 'preview'
  workspace.view.editor = {
    ...entry,
    noteReferences,
    tagsText: entry.tags.join(', '),
    dirty: false,
    isNew: false,
    saveState: '已保存',
  }
  return true
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
    scope: { kind: 'global' }, confidence: .8, noteReferences: [], dirty: true, isNew: true, saveState: '新文档',
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
  workspace.view.editor = null
  workspace.view.editorLoading = true
  workspace.view.loadingDocumentId = id
  renderShell()
  try {
    await loadDocumentEditor(workspace, id)
  } catch (error) {
    if (workspace.view.documentId === id) showToast(friendlyError(error), 'error')
  } finally {
    if (workspace.view.loadingDocumentId === id) {
      workspace.view.editorLoading = false
      workspace.view.loadingDocumentId = ''
      renderShell()
    }
  }
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

function activateKnowledgeBaseDropTarget(event, workspace, baseId) {
  const drag = knowledgeDocumentDrag
  if (!drag || drag.workspaceKind !== workspace.kind || drag.sourceBaseId === baseId) return
  if (!hasDragType(event, KNOWLEDGE_DOCUMENT_DRAG_TYPE)) return
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  document.querySelectorAll('.note-tree-group[data-drop-target="true"]').forEach(target => {
    if (target !== event.currentTarget) target.dataset.dropTarget = 'false'
  })
  event.currentTarget.dataset.dropTarget = 'true'
}

function clearKnowledgeDocumentDragState() {
  knowledgeDocumentDrag = null
  document.querySelectorAll('.note-tree-group[data-drop-target="true"]').forEach(node => { node.dataset.dropTarget = 'false' })
  document.querySelectorAll('.note-tree-document[data-dragging="true"]').forEach(node => { node.dataset.dragging = 'false' })
}

function dropKnowledgeDocument(event, workspace, targetBaseId) {
  const documentId = event.dataTransfer?.getData(KNOWLEDGE_DOCUMENT_DRAG_TYPE) || ''
  const source = documentWorkspaceDocuments(workspace).find(document => document.id === documentId)
  if (!documentId || !source || source.knowledgeBaseId === targetBaseId) return
  event.preventDefault()
  event.stopPropagation()
  clearKnowledgeDocumentDragState()
  void moveKnowledgeDocument(workspace, documentId, targetBaseId)
}

async function moveKnowledgeDocument(workspace, documentId, targetBaseId) {
  const bases = documentWorkspaceBases(workspace)
  const target = bases.find(base => base.id === targetBaseId && base.status === 'active')
  const summaries = documentWorkspaceDocuments(workspace)
  const current = summaries.find(document => document.id === documentId)
  const sourceBaseId = current?.knowledgeBaseId
    || (workspace.view.editor?.id === documentId ? workspace.view.editor.knowledgeBaseId : '')
  if (!target || !sourceBaseId || sourceBaseId === targetBaseId || movingDocumentId) return false
  const editor = workspace.view.editor
  if (editor?.id === documentId && editor.dirty && !await saveDocumentEditor(workspace)) return false

  movingDocumentId = documentId
  renderShell()
  try {
    const saved = await api(`documents/${encodeURIComponent(documentId)}/move`, {
      method: 'POST', body: { knowledgeBaseId: targetBaseId },
    })
    const latest = documentWorkspaceDocuments(workspace)
    const summary = latest.find(document => document.id === documentId) || current
    if (summary) {
      setDocumentWorkspaceDocuments(workspace, [
        { ...summary, knowledgeBaseId: targetBaseId, updatedAt: saved.updatedAt },
        ...latest.filter(document => document.id !== documentId),
      ])
    }
    workspace.view.searchResults = workspace.view.searchResults.map(document => document.id === documentId
      ? { ...document, knowledgeBaseId: targetBaseId, updatedAt: saved.updatedAt }
      : document)
    const sourcePage = documentPageState(workspace, sourceBaseId)
    const targetPage = documentPageState(workspace, targetBaseId)
    if (sourcePage.loaded) sourcePage.total = Math.max(0, sourcePage.total - 1)
    if (targetPage.loaded) targetPage.total += 1
    workspace.view.knowledgeBaseId = targetBaseId
    workspace.view.expandedBases.add(targetBaseId)
    if (workspace.view.documentId === documentId && workspace.view.editor?.id === documentId) {
      workspace.view.editor = {
        ...workspace.view.editor,
        ...saved,
        tagsText: saved.tags.join(', '),
        dirty: false,
        isNew: false,
        saveState: '已移动',
      }
    }
    showToast(`已移动到“${target.name}”。`)
    return true
  } catch (error) {
    showToast(friendlyError(error), 'error')
    return false
  } finally {
    movingDocumentId = ''
    renderShell()
  }
}

function openMoveKnowledgeDocument(workspace, editor) {
  const targets = documentWorkspaceBases(workspace).filter(base => base.status === 'active' && base.id !== editor.knowledgeBaseId)
  if (!targets.length) return showToast('当前没有其他可移动到的知识库。', 'error')
  const form = element('form', { class: 'form-grid' })
  const destination = selectField('目标知识库', targets.map(base => ({ value: base.id, label: base.name })), targets[0].id)
  destination.wrapper.classList.add('span-2')
  form.append(destination.wrapper)
  return openSheet({
    title: `移动“${editor.title}”`,
    description: '文档 ID、版本历史和关联笔记都会保留，Markdown 投影将同步移动。',
    body: form,
    primaryLabel: '移动文档',
    onPrimary: () => moveKnowledgeDocument(workspace, editor.id, destination.input.value),
  })
}

function updateEditorSaveState(label) {
  const node = document.querySelector('.editor-save-status')
  if (node) node.textContent = label
}

async function loadCandidates(signal) {
  const [payload] = await Promise.all([
    api(`candidates?status=${state.candidateStatus}&limit=100&includeTargets=1`, { signal }),
    ensureKnowledgeBases(false, signal),
  ])
  const candidates = payload.items
  state.candidates = candidates
  state.candidateTargets = new Map(payload.targets.map(target => [target.id, target]))
  if (!state.stats) await refreshStats(signal)
}

async function loadTokens(signal) {
  const [tokens, service] = await Promise.all([api('tokens', { signal }), api('service', { signal })])
  state.tokens = tokens
  state.service = service
  if (!state.stats) await refreshStats(signal)
}

function renderShell() {
  releaseNoteEditors()
  captureScrollPosition()
  const titles = {
    overview: ['概览', '知识库运行状态与最近活动'],
    bases: ['知识库与挂载', '管理知识目录，并限定项目与会话的召回和写入范围'],
    entries: ['知识文档', '在知识目录中阅读、整理和维护 Markdown 文档'],
    notes: ['笔记文档', '像本地目录一样整理笔记和资料，并按需关联到知识文档'],
    candidates: ['待审核', '确认 AI 提取结果后再写入知识文档'],
    tokens: ['访问管理', '管理其他客户端连接中央知识库的权限'],
  }
  const [title, subtitle] = titles[state.view]
  const viewIndexes = { overview: '00', notes: '01', entries: '02', candidates: '03', bases: '04', tokens: '05' }
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
    state.menuOpen ? element('button', {
      type: 'button', class: 'app-sidebar-scrim',
      'aria-label': '关闭导航菜单',
      onClick: () => { state.menuOpen = false; renderShell() },
    }) : null,
    element('main', { class: 'main' },
      element('header', { class: 'topbar' },
        element('div', { class: 'topbar-title' },
          actionButton('☰', () => { state.menuOpen = !state.menuOpen; renderShell() }, 'ghost mobile-menu', {
            'aria-label': state.menuOpen ? '关闭导航菜单' : '打开导航菜单',
            'aria-expanded': String(state.menuOpen),
          }),
          paneToggleButton('main', !state.documentView.sidebarHidden, () => setSidebarHidden(!state.documentView.sidebarHidden), '主导航栏'),
          activeDocumentWorkspace() ? paneToggleButton('library', activeDocumentWorkspace().view.treeOpen, () => {
            const workspace = activeDocumentWorkspace()
            if (!workspace) return
            workspace.view.treeOpen = !workspace.view.treeOpen
            renderShell()
          }, '知识目录') : null,
          element('div', { class: 'topbar-heading' },
            element('span', { class: 'topbar-kicker' }, `KNOWLEDGE / ${viewIndexes[state.view] || '00'}`),
            element('h1', {}, title),
            element('p', {}, subtitle)),
        ),
        state.loading ? element('div', {
          class: 'route-progress', role: 'progressbar', 'aria-label': state.loadingPhase || '正在加载',
          'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(state.loadingProgress * 100)),
        }, element('span', { style: `--route-progress: ${state.loadingProgress}` })) : null,
      ),
      element('div', { class: 'page' }, element('div', { class: 'view-stage', 'data-view-stage': state.view }, renderCurrentView())),
    ),
  )
  app.replaceChildren(shell)
  applySidebarVisibility(shell, state.documentView.sidebarHidden)
  refreshWorkspaceEffects(shell)
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
  const shell = app.querySelector('.app-shell')
  if (shell) applySidebarVisibility(shell, hidden)
}

function applySidebarVisibility(shell, hidden) {
  shell.dataset.sidebarHidden = String(hidden)
  const sidebar = shell.querySelector(':scope > .sidebar')
  const resizer = shell.querySelector(':scope > .app-sidebar-resizer')
  const main = shell.querySelector(':scope > .main')
  const toggle = shell.querySelector('.pane-toggle-button[data-pane="main"]')
  const compact = window.matchMedia('(max-width: 760px)').matches
  const sidebarUnavailable = compact ? !state.menuOpen : hidden
  sidebar?.toggleAttribute('inert', sidebarUnavailable)
  resizer?.toggleAttribute('inert', hidden)
  main?.toggleAttribute('inert', compact && state.menuOpen)
  if (sidebar) {
    if (sidebarUnavailable) sidebar.setAttribute('aria-hidden', 'true')
    else sidebar.removeAttribute('aria-hidden')
  }
  if (resizer) {
    resizer.tabIndex = hidden ? -1 : 0
    if (hidden) resizer.setAttribute('aria-hidden', 'true')
    else resizer.removeAttribute('aria-hidden')
  }
  if (toggle) {
    const visible = !hidden
    const action = `${visible ? '隐藏' : '显示'}主导航栏`
    toggle.setAttribute('aria-pressed', String(visible))
    toggle.setAttribute('aria-label', action)
    toggle.title = action
  }
}

function renderSidebar() {
  const pending = state.stats?.candidates.pending
  const navGroups = [
    ['笔记工作区', [['notes', '笔记文档']]],
    ['知识工作区', [['entries', '知识文档'], ['candidates', '待审核'], ['bases', '知识库与挂载']]],
    ['连接', [['tokens', '访问管理']].filter(([id]) => id !== 'tokens' || !state.service.remote)],
  ].filter(([, items]) => items.length)
  let navIndex = 0
  return element('aside', { class: 'sidebar', 'aria-label': '知识库导航' },
    element('div', { class: 'brand' },
      element('span', { class: 'brand-emblem', 'aria-hidden': 'true' }, element('span', {})),
      element('div', { class: 'brand-copy' }, element('span', {}, 'DSH Knowledge'), element('strong', {}, '知识库')),
    ),
    element('nav', { class: 'nav' }, navGroups.map(([group, items]) => element('div', { class: 'nav-group' },
      element('div', { class: 'nav-group-label' }, group),
      items.map(([id, label]) => element('button', {
        type: 'button', class: 'nav-button', 'aria-current': state.view === id ? 'page' : undefined,
        onClick: () => navigate(id),
      }, element('span', { class: 'nav-index', 'aria-hidden': 'true' }, String(++navIndex).padStart(2, '0')), element('span', { class: 'nav-label' }, label),
      id === 'candidates' && pending ? element('span', { class: 'nav-count', 'aria-label': `${pending} 条待审核` }, pending) : null))))),
    element('div', { class: 'sidebar-footer' },
      element('div', { class: 'connection' }, element('span', { class: 'status-dot', 'aria-hidden': 'true' }), state.service.remote ? '中央知识库已连接' : '本地知识库已连接'),
      AUTH_MODE === 'bearer' ? actionButton('退出当前会话', signOut, 'ghost small') : null,
    ),
  )
}

function renderCurrentView() {
  if (state.loading) return loadingView(state.view, state.loadingPhase, state.loadingProgress)
  if (state.error) return errorView(state.error, () => navigate(state.view))
  if (state.view === 'overview') return renderOverview()
  if (state.view === 'bases') return renderKnowledgeBases()
  if (state.view === 'entries') return renderEntries()
  if (state.view === 'notes') return renderNotes()
  if (state.view === 'candidates') return renderCandidates()
  return renderTokens()
}

function loadingView(view = state.view, phase = '正在加载', progress = 0) {
  const label = phase || loadingPhaseForView(view)
  const header = element('div', { class: 'skeleton-heading' },
    element('div', {}, element('div', { class: 'skeleton-line skeleton-title', 'aria-hidden': 'true' }), element('div', { class: 'skeleton-line skeleton-copy', 'aria-hidden': 'true' })),
    element('span', { class: 'skeleton-phase' }, label),
  )
  const content = view === 'entries'
    ? element('div', { class: 'skeleton-workspace skeleton-workspace-documents', 'aria-hidden': 'true' },
      element('div', { class: 'skeleton-pane skeleton-pane-tree' }, ...Array.from({ length: 7 }, (_, index) => element('div', { class: `skeleton-line skeleton-tree-row is-${index % 3}` }))),
      element('div', { class: 'skeleton-pane skeleton-pane-paper' }, element('div', { class: 'skeleton-line skeleton-paper-title' }), ...Array.from({ length: 8 }, (_, index) => element('div', { class: `skeleton-line skeleton-paper-row is-${index % 4}` }))),
    )
    : view === 'notes'
      ? element('div', { class: 'skeleton-workspace skeleton-workspace-notes', 'aria-hidden': 'true' },
        element('div', { class: 'skeleton-pane skeleton-pane-tree' }, ...Array.from({ length: 8 }, (_, index) => element('div', { class: `skeleton-line skeleton-tree-row is-${index % 3}` }))),
        element('div', { class: 'skeleton-pane skeleton-pane-list' }, ...Array.from({ length: 6 }, () => element('div', { class: 'skeleton-list-row' }, element('span', { class: 'skeleton-block' }), element('span', { class: 'skeleton-line' })))),
      )
      : element('div', { class: 'skeleton-grid', 'aria-hidden': 'true' },
        element('div', { class: 'skeleton-block' }), element('div', { class: 'skeleton-block' }), element('div', { class: 'skeleton-block' }))
  return element('div', {
    class: `loading-skeleton loading-skeleton--${view}`, role: 'status', 'aria-label': label,
    style: `--loading-progress: ${progress}`,
  }, element('span', { class: 'visually-hidden' }, label), header, content)
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
  const request = ++libraryDetailRequest
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
    if (!await reloadDocumentWorkspace(workspace) || request !== libraryDetailRequest) return
    selectDefaultDocument(workspace)
    if (workspace.view.documentId) await loadDocumentEditor(workspace, workspace.view.documentId)
    else workspace.view.editor = null
  } catch (error) {
    if (request !== libraryDetailRequest) return
    detail.error = friendlyError(error)
  } finally {
    if (request !== libraryDetailRequest) return
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
  libraryDetailRequest += 1
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

function writebackRouteLabel(base) {
  if (state.service.writebackProvider && state.service.writebackModel) {
    return `本机覆盖 · ${state.service.writebackProvider} / ${state.service.writebackModel}`
  }
  if (base?.writebackProvider && base?.writebackModel) {
    return `知识库专用 · ${base.writebackProvider} / ${base.writebackModel}`
  }
  return '跟随当前会话模型'
}

function renderKnowledgeBaseCard(base) {
  const archived = base.status === 'archived'
  const visibleTags = base.defaultTags.slice(0, 4)
  const hiddenTagCount = Math.max(0, base.defaultTags.length - visibleTags.length)
  return element('article', {
    class: `base-card${archived ? ' is-archived' : ''}`,
    'data-knowledge-motion-key': `knowledge-library:${base.id}`,
  },
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
      element('span', {}, element('strong', {}, '回写模型'), writebackRouteLabel(base)),
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
  const modelLabel = writebackRouteLabel(base)
  return element('article', {
    class: `mount-list-row${selected ? ' is-selected' : ''}`,
    role: 'listitem',
    'data-knowledge-motion-key': `knowledge-mount:${targetKind}:${base.id}`,
  },
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
  const canOrganize = !readOnly && activeBases.length > 1
  const selectedBase = activeBases.find(base => base.id === view.knowledgeBaseId)
  const search = element('input', {
    class: 'note-tree-search', type: 'search', value: view.query, placeholder: '搜索文档', 'aria-label': '搜索知识库文档',
    'data-document-scope': workspace.kind,
    onInput: (event) => {
      view.query = event.target.value
      scheduleDocumentSearch(workspace)
      window.requestAnimationFrame(() => {
        const input = document.querySelector(`.note-tree-search[data-document-scope="${workspace.kind}"]`)
        input?.focus()
        input?.setSelectionRange(input.value.length, input.value.length)
      })
    },
  })
  const visibleBases = query
    ? activeBases.filter(base => view.searchResults.some(document => document.knowledgeBaseId === base.id))
    : activeBases
  const tree = visibleBases.map(base => {
    const expanded = view.expandedBases.has(base.id) || Boolean(query)
    const page = documentPageState(workspace, base.id)
    const documents = (query ? view.searchResults : workspaceDocuments).filter(document => document.knowledgeBaseId === base.id)
    return element('section', {
      class: 'note-tree-group', 'data-expanded': String(expanded),
      'data-base-id': base.id, 'data-drop-target': 'false',
      onDragEnter: event => activateKnowledgeBaseDropTarget(event, workspace, base.id),
      onDragOver: event => activateKnowledgeBaseDropTarget(event, workspace, base.id),
      onDragLeave: event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.dataset.dropTarget = 'false' },
      onDrop: event => dropKnowledgeDocument(event, workspace, base.id),
    },
      element('button', {
        type: 'button', class: 'note-tree-base', 'aria-expanded': String(expanded),
        'data-knowledge-motion-key': `knowledge-base:${workspace.kind}:${base.id}`,
        onClick: () => {
          if (query) { view.knowledgeBaseId = base.id; return renderShell() }
          void toggleDocumentBase(workspace, base.id)
        },
      },
      element('span', { class: 'tree-disclosure', 'aria-hidden': 'true' }),
      element('span', { class: 'tree-folder-icon', 'aria-hidden': 'true' }),
      element('span', { class: 'tree-base-name' }, base.name),
      element('span', { class: 'tree-count' }, query ? documents.length : page.loaded ? page.total : '—')),
      expanded ? element('div', { class: 'note-tree-documents', role: 'group', 'aria-label': `${base.name}文档` },
        !query && page.loading && documents.length === 0 ? element('div', { class: 'note-tree-status', role: 'status' }, '正在读取目录…') : null,
        !query && page.error ? element('div', { class: 'note-tree-status is-error' },
          element('span', {}, page.error),
          actionButton('重试', () => { void loadDocumentPage(workspace, base.id, { reset: true }).then(renderShell) }, 'ghost small')) : null,
        documents.map(document => element('button', {
          type: 'button', class: 'note-tree-document', 'aria-current': document.id === view.documentId ? 'page' : undefined,
          draggable: canOrganize && movingDocumentId !== document.id ? 'true' : undefined,
          'aria-busy': movingDocumentId === document.id ? 'true' : undefined,
          title: canOrganize ? `${document.title} · 拖到其他知识库以移动` : document.title,
          'data-document-id': document.id,
          'data-knowledge-motion-key': `knowledge-document:${workspace.kind}:${document.id}`,
          onDragStart: event => {
            knowledgeDocumentDrag = { documentId: document.id, sourceBaseId: base.id, workspaceKind: workspace.kind }
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData(KNOWLEDGE_DOCUMENT_DRAG_TYPE, document.id)
            event.currentTarget.dataset.dragging = 'true'
          },
          onDragEnd: clearKnowledgeDocumentDragState,
          onClick: () => { view.knowledgeBaseId = base.id; void selectDocument(workspace, document.id) },
        }, element('span', { class: 'tree-document-icon', 'aria-hidden': 'true' }), element('span', { class: 'tree-document-copy' },
          element('strong', {}, document.title), element('small', {}, document.relPath)),
        document.documentState !== 'open' ? badge(DOCUMENT_STATE_LABELS[document.documentState] || '已结束', 'success') : null)),
        !query && page.nextCursor ? element('button', {
          type: 'button', class: 'note-tree-more', disabled: page.loading,
          onClick: () => { void loadDocumentPage(workspace, base.id, { append: true }).then(renderShell) },
        }, page.loading ? '正在加载…' : `继续加载（已显示 ${documents.length} / ${page.total}）`) : null,
        !query && page.loaded && documents.length === 0 ? element('div', { class: 'note-tree-status' }, '这个知识库还没有文档。') : null,
        !query && !readOnly ? element('button', { type: 'button', class: 'note-tree-new', onClick: () => { void startBlankDocument(workspace, base.id) } },
          element('span', { 'aria-hidden': 'true' }, '+'), '新建文档') : null,
      ) : null,
    )
  })
  const treeContent = query
    ? [
      view.searchLoading && view.searchResults.length === 0 ? element('div', { class: 'note-tree-status', role: 'status' }, '正在搜索文档…') : null,
      view.searchError ? element('div', { class: 'note-tree-status is-error' }, view.searchError) : null,
      ...tree,
      !view.searchLoading && !view.searchError && view.searchResults.length === 0 ? element('div', { class: 'note-tree-empty' }, '没有匹配的文档') : null,
      view.searchNextCursor ? element('button', {
        type: 'button', class: 'note-tree-more search-more', disabled: view.searchLoading,
        onClick: () => { void loadDocumentSearch(workspace, false) },
      }, view.searchLoading ? '正在加载…' : `继续加载搜索结果（${view.searchResults.length} / ${view.searchTotal}）`) : null,
    ]
    : tree.length ? tree : [element('div', { class: 'note-tree-empty' }, workspace.kind === 'session' && state.mountContext.sessionId ? '当前会话未挂载知识库' : '还没有知识库')]
  return element('section', {
    class: `note-workspace note-workspace--${workspace.kind}`, 'aria-labelledby': `${workspace.kind}-documents-heading`,
    'data-tree-open': String(view.treeOpen),
  },
    element('aside', { class: 'note-tree-panel', 'aria-label': '知识目录' },
      element('header', { class: 'note-tree-header' },
        element('div', {}, element('h2', { id: `${workspace.kind}-documents-heading` }, options.heading || '知识目录'), element('span', {}, query ? `${view.searchTotal} 条搜索结果` : `${workspaceDocuments.length} 篇已加载`)),
        !readOnly ? actionButton('+', () => { void startBlankDocument(workspace, view.knowledgeBaseId || activeBases[0]?.id) }, 'ghost note-add-button', { 'aria-label': '新建文档', title: '新建文档' }) : null,
      ),
      element('div', { class: 'note-tree-search-wrap' }, interfaceIcon('search', 'search-symbol'), search),
      element('nav', { class: 'note-tree', 'data-scroll-key': `${workspace.kind}-note-tree` }, treeContent),
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
  if (view.editorLoading) return renderDocumentEditorLoading(base)
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
  const finalized = !editor.isNew && editor.documentState !== 'open'
  const editable = !finalized && !readOnly
  const body = editable
    ? element('div', { class: 'notes-live-editor knowledge-live-editor', role: 'status', 'aria-label': '正在打开知识文档正文' },
      element('div', { class: 'notes-editor-loading' }, '正在打开文档…'))
    : renderMarkdownPreview(editor.body)
  if (editable) mountMarkdownEditor(body, {
    markdown: editor.body,
    label: '编辑知识文档正文',
    onChange: value => update('body', value),
    onSave: () => { void saveDocumentEditor(workspace).then(saved => { if (saved) renderShell() }) },
  })
  return element('main', { class: 'note-editor', 'aria-label': '文档编辑器' },
    element('header', { class: 'note-editor-toolbar' },
      element('div', { class: 'note-breadcrumb' },
        element('span', {}, base?.name || '知识库'),
        element('span', { 'aria-hidden': 'true' }, '/'),
        element('strong', {}, editor.isNew ? '新文档' : documentWorkspaceDocuments(workspace).find(item => item.id === editor.id)?.relPath || editor.title),
        element('span', { class: 'note-toolbar-meta' },
          element('span', {}, editor.isNew ? '尚未保存' : `更新于 ${formatDate(editor.updatedAt)}`),
          element('span', {}, editor.scope.kind === 'global' ? '全局知识' : `项目 ${editor.scope.id}`))),
      element('div', { class: 'note-editor-actions' },
        finalized ? badge(DOCUMENT_STATE_LABELS[editor.documentState] || '已结束', 'success') : readOnly ? badge('只读') : null,
        element('span', { class: 'editor-save-status', role: 'status' }, editor.saveState),
        !readOnly && !editor.isNew && documentWorkspaceBases(workspace).some(item => item.id !== editor.knowledgeBaseId)
          ? actionButton('移动到…', () => openMoveKnowledgeDocument(workspace, editor), 'ghost small')
          : null,
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
      element('article', { class: `note-paper is-${editable ? 'edit' : 'preview'}`, 'data-document-mode': editable ? 'edit' : 'preview' },
        editable ? title : element('h1', { class: 'note-preview-title' }, editor.title || '无标题文档'),
        body,
      ),
    ),
    renderDocumentReferenceBar(workspace, editor, editable),
    element('footer', { class: 'note-inspector' },
      finalized || readOnly ? element('span', { class: 'note-format-hint' }, readOnly ? '知识库已归档 · 只读' : '只读封存 · 重新打开后才能编辑') : element('label', {}, element('span', {}, '类型'), element('select', {
        class: 'note-meta-select', onChange: event => update('type', event.target.value),
      }, TYPES.map(type => element('option', { value: type, selected: type === editor.type }, TYPE_LABELS[type])))),
      finalized || readOnly ? null : element('label', { class: 'note-tags-field' }, element('span', {}, '标签'), element('input', {
        value: editor.tagsText, placeholder: '用逗号分隔', onInput: event => update('tagsText', event.target.value),
      })),
      editable ? element('span', { class: 'note-format-hint' }, 'Markdown · Ctrl/⌘ S 保存') : null,
    ),
  )
}

function renderDocumentEditorLoading(base) {
  return element('main', { class: 'note-editor note-editor-loading', role: 'status', 'aria-label': '正在打开知识文档' },
    element('header', { class: 'note-editor-toolbar' },
      element('div', { class: 'note-breadcrumb' }, element('span', {}, base?.name || '知识库'), element('span', { 'aria-hidden': 'true' }, '/'), element('strong', {}, '正在打开文档')),
      element('span', { class: 'editor-load-label' }, '按需加载正文与关联笔记'),
    ),
    element('div', { class: 'note-editor-scroll' }, element('article', { class: 'note-paper editor-paper-skeleton', 'aria-hidden': 'true' },
      element('div', { class: 'skeleton-line skeleton-paper-title' }),
      ...Array.from({ length: 9 }, (_, index) => element('div', { class: `skeleton-line skeleton-paper-row is-${index % 4}` })),
    )),
  )
}

function renderDocumentReferenceBar(workspace, editor, editable) {
  const references = editor.noteReferences || []
  return element('section', { class: 'document-reference-bar', 'aria-label': '关联笔记' },
    element('div', { class: 'document-reference-heading' },
      element('span', { class: 'document-reference-mark', 'aria-hidden': 'true' }),
      element('strong', {}, '关联笔记'),
      element('small', {}, references.length ? `${references.length} 项` : '未关联')),
    element('div', { class: 'document-reference-list' }, references.length
      ? references.map(reference => element('span', { class: 'document-reference-chip' },
        element('button', {
          type: 'button', class: 'document-reference-open', title: `打开 ${reference.note.name}`,
          onClick: () => { void openNoteReference(reference.note.id) },
        }, renderNoteIcon(reference.note), element('span', {}, reference.note.name)),
        editable ? element('button', {
          type: 'button', class: 'document-reference-remove', 'aria-label': `移除 ${reference.note.name} 的关联`, title: '移除关联',
          onClick: () => { void removeDocumentNoteReference(workspace, editor, reference) },
        }, '×') : null,
      ))
      : element('span', { class: 'document-reference-empty' }, editor.isNew ? '保存文档后可以关联笔记或资料文件' : '这篇知识还没有关联笔记')),
    editable && !editor.isNew ? actionButton('+ 添加', () => { void openDocumentNoteReferencePicker(workspace, editor) }, 'ghost small document-reference-add') : null,
  )
}

async function openDocumentNoteReferencePicker(workspace, editor) {
  const search = element('input', {
    class: 'input', type: 'search', placeholder: '搜索笔记文档或文件', 'aria-label': '搜索可关联的笔记',
  })
  const results = element('div', { class: 'note-picker-results', 'aria-live': 'polite' })
  let modal
  let request = 0
  const paint = async () => {
    const current = ++request
    const query = search.value.trim()
    if (!query) {
      results.replaceChildren(element('div', { class: 'note-picker-empty' }, '输入名称以搜索可关联的笔记文档和文件。'))
      return
    }
    results.replaceChildren(element('div', { class: 'note-picker-empty' }, '正在搜索…'))
    try {
      const linked = new Set((editor.noteReferences || []).map(reference => reference.note.id))
      const visible = (await api(`notes?q=${encodeURIComponent(query)}&limit=100`)).filter(node => node.kind !== 'folder' && !linked.has(node.id))
      if (current !== request) return
      results.replaceChildren(...(visible.length
        ? visible.map(node => element('button', {
          type: 'button', class: 'note-picker-row',
          onClick: async event => {
            event.currentTarget.disabled = true
            try {
              const reference = await api(`entries/${encodeURIComponent(editor.id)}/note-references`, { method: 'POST', body: { noteId: node.id } })
              editor.noteReferences = [...(editor.noteReferences || []), reference]
              modal.close(true)
              renderShell()
              showToast('已关联笔记。')
            } catch (error) {
              event.currentTarget.disabled = false
              showToast(friendlyError(error), 'error')
            }
          },
        },
        renderNoteIcon(node),
        element('span', {}, element('strong', {}, node.name), element('small', {}, `${node.kind === 'document' ? '笔记文档' : formatBytes(node.size)}  ${shortNoteId(node.id)}`))))
        : [element('div', { class: 'note-picker-empty' }, '没有匹配的笔记文档或文件。')]))
    } catch (error) {
      if (current !== request) return
      results.replaceChildren(element('div', { class: 'note-picker-empty is-error' }, friendlyError(error)))
    }
  }
  let timer = 0
  search.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(() => void paint(), 180) })
  modal = openSheet({
    title: '添加关联笔记',
    description: '关联保存在文档正文之外；笔记移动或改名后仍然有效。',
    body: element('div', { class: 'note-picker' }, search, results),
    cancelLabel: '取消',
  })
  search.focus()
}

async function removeDocumentNoteReference(workspace, editor, reference) {
  try {
    await api(`entries/${encodeURIComponent(editor.id)}/note-references/${encodeURIComponent(reference.note.id)}`, { method: 'DELETE' })
    editor.noteReferences = (editor.noteReferences || []).filter(item => item.note.id !== reference.note.id)
    if (workspace.view.editor === editor) renderShell()
    showToast('已移除关联。')
  } catch (error) { showToast(friendlyError(error), 'error') }
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
  preview.querySelectorAll('[data-note-id]').forEach(link => {
    link.setAttribute('role', 'button')
    link.setAttribute('tabindex', '0')
    link.setAttribute('title', '打开笔记文档')
    const open = event => {
      if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      void openNoteReference(link.dataset.noteId)
    }
    link.addEventListener('click', open)
    link.addEventListener('keydown', open)
  })
  return preview
}

async function openNoteReference(id) {
  try {
    if (!await saveBeforeLeavingDocument()) return
    const node = await api(`notes/${encodeURIComponent(id)}`)
    state.view = 'notes'
    state.loading = false
    await selectNoteNode(node)
    renderShell()
  } catch (error) { showToast(friendlyError(error), 'error') }
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

function renderNotes() {
  const fileInput = element('input', {
    class: 'visually-hidden', type: 'file', multiple: true, tabindex: '-1',
    onChange: event => { void uploadNoteFiles([...event.target.files], state.notes.currentFolderId); event.target.value = '' },
  })
  const rootNodes = state.notes.children.get('root') || []
  const tree = state.notes.query.trim()
    ? renderNoteSearchResults()
    : renderNoteTreeBranch(null)
  const workspace = element('section', {
    class: 'notes-workspace', 'data-drop-active': 'false',
    onDragEnter: noteWorkspaceDragEnter, onDragOver: noteWorkspaceDragEnter,
    onDragLeave: noteWorkspaceDragLeave,
    onDrop: event => {
      clearNoteDragState()
      if (!hasDragType(event, 'Files')) return
      event.preventDefault()
      void importDroppedNotes(event.dataTransfer, state.notes.currentFolderId)
    },
  },
    element('aside', { class: 'notes-browser', 'aria-label': '笔记目录' },
      element('header', { class: 'notes-browser-header' },
        element('div', {}, element('h2', {}, '目录'), element('span', {}, `${rootNodes.length} 个根目录项目`)),
        element('div', { class: 'notes-browser-actions' },
          actionButton('新建', () => openCreateNoteDocument(), 'primary small'),
          actionButton('目录', () => openCreateNoteFolder(), 'small'),
          actionButton('导入', () => fileInput.click(), 'ghost small'),
          actionButton('会话指令', openNoteAgentGuide, 'ghost small'),
          fileInput,
        ),
      ),
      element('div', { class: 'notes-search' }, element('input', {
        class: 'input', type: 'search', value: state.notes.query, placeholder: '搜索笔记文档', 'aria-label': '搜索笔记文档',
        onInput: event => scheduleNoteSearch(event.target.value),
      })),
      element('div', {
        class: 'notes-tree', role: 'tree', 'data-scroll-key': 'notes-tree',
        onDragOver: event => {
          if (hasDragType(event, 'application/x-dsh-note-id') || hasDragType(event, 'Files')) event.preventDefault()
        },
        onDrop: event => { if (event.target === event.currentTarget) void dropNoteNode(event, null) },
      }, tree),
    ),
    renderNoteContent(),
    element('div', { class: 'notes-drop-overlay', 'aria-hidden': 'true' },
      element('strong', {}, '放开以导入当前目录'),
      element('span', {}, '支持文件和完整目录，原有目录层级会被保留。')),
    renderNoteTransfer(),
  )
  return element('section', { class: 'notes-page', 'aria-label': '笔记工作区' }, workspace)
}

function openNoteAgentGuide() {
  const capabilityRows = [
    ['笔记文档', '创建、追加或替换内容、重命名、移动、删除'],
    ['笔记目录', '创建、重命名、移动、删除'],
  ].map(([label, detail]) => element('div', { class: 'notes-agent-capability' },
    element('strong', {}, label), element('span', {}, detail)))
  const examples = [
    ['创建', '在笔记工作区的「发布资料」目录里，新建笔记文档「上线检查.md」，内容是：……'],
    ['更新', '把笔记文档「发布资料/上线检查.md」追加以下内容：……'],
    ['目录', '把笔记目录「发布资料」重命名为「发布归档」。'],
  ].map(([label, text]) => element('li', {}, element('span', {}, label), element('code', {}, text)))
  const body = element('div', { class: 'notes-agent-guide' },
    element('section', { class: 'notes-agent-guide-rule' },
      element('span', { class: 'notes-agent-guide-index', 'aria-hidden': 'true' }, '01'),
      element('div', {},
        element('h3', {}, '在当前消息里指定笔记文档'),
        element('p', {}, '只要当前消息明确提到“笔记文档”“笔记目录”或“笔记工作区”，会话就可以按你的要求查看和维护；无需套用固定句式。为了避免误操作，删除仍需明确说出删除，授权也不会从上一轮延续。'))),
    element('section', { class: 'notes-agent-guide-rule' },
      element('span', { class: 'notes-agent-guide-index', 'aria-hidden': 'true' }, '02'),
      element('div', {},
        element('h3', {}, '名称足够，重名时补全路径'),
        element('p', {}, '不需要填写内部编号。会话会先浏览笔记目录定位目标；如果有重名，请写成“目录/子目录/文档名”。'))),
    element('div', { class: 'notes-agent-capabilities', 'aria-label': '会话可执行的笔记操作' }, capabilityRows),
    element('section', { class: 'notes-agent-examples' },
      element('h3', {}, '可以直接这样说'),
      element('ul', {}, examples)),
    element('p', { class: 'notes-agent-guide-note' }, '只说“新建 Markdown”或“创建本地目录”仍不会获得笔记权限；在当前消息中带上“笔记文档”即可。'))
  return openSheet({
    title: '让会话整理笔记',
    description: '会话可以操作笔记工作区，但每次写入都需要当前用户消息明确授权。',
    body,
    cancelLabel: '知道了',
  })
}

function renderNoteTransfer() {
  const transfer = state.notes.transfer
  if (!transfer) return null
  const dismissible = transfer.phase === 'complete' || transfer.phase === 'error'
  return element('section', {
    class: 'notes-transfer', 'data-note-transfer': transfer.id, 'data-state': transfer.phase,
    role: transfer.phase === 'error' ? 'alert' : 'status', 'aria-live': 'polite',
  },
    element('div', { class: 'notes-transfer-heading' },
      element('span', { class: 'notes-transfer-mark', 'aria-hidden': 'true' }),
      element('strong', { class: 'notes-transfer-title' }, noteTransferTitle(transfer)),
      dismissible ? actionButton('关闭', dismissNoteTransfer, 'ghost tiny notes-transfer-close', { 'aria-label': '关闭导入进度' }) : null,
    ),
    element('div', { class: 'notes-transfer-detail', title: transfer.currentName || '' }, noteTransferDetail(transfer)),
    element('div', {
      class: 'notes-transfer-track', role: 'progressbar',
      'aria-label': '笔记导入进度', 'aria-valuemin': '0', 'aria-valuemax': '100',
      'aria-valuenow': transfer.phase === 'scanning' ? undefined : String(noteTransferPercent(transfer)),
    }, element('span', { class: 'notes-transfer-fill' })),
    element('div', { class: 'notes-transfer-meta' },
      element('span', { class: 'notes-transfer-count' }, noteTransferCount(transfer)),
      element('span', { class: 'notes-transfer-percent' }, transfer.phase === 'scanning' ? '正在整理' : `${noteTransferPercent(transfer)}%`),
    ),
  )
}

function renderNoteTreeBranch(parentId, depth = 0) {
  const key = parentId || 'root'
  const nodes = state.notes.children.get(key) || []
  if (!nodes.length && depth === 0) {
    return element('div', { class: 'notes-tree-empty' }, element('strong', {}, '还没有笔记'), element('span', {}, '新建目录或文档开始整理。'))
  }
  return element('div', { class: 'notes-tree-branch', role: depth ? 'group' : undefined }, nodes.map(node => {
    const selected = state.notes.selectedId === node.id
    const expanded = node.kind === 'folder' && state.notes.expandedFolders.has(node.id)
    const row = element('div', {
      class: 'notes-tree-item', 'data-kind': node.kind, 'data-selected': String(selected),
      'data-note-id': node.id,
      'data-knowledge-motion-key': `note:${node.id}`,
      draggable: 'true',
      onDragStart: event => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('application/x-dsh-note-id', node.id)
        event.currentTarget.dataset.dragging = 'true'
      },
      onDragEnd: () => clearNoteDragState(),
      onDragEnter: event => activateNoteFolderDropTarget(event, node),
      onDragOver: event => activateNoteFolderDropTarget(event, node),
      onDragLeave: event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.dataset.dropTarget = 'false' },
      onDrop: event => { if (node.kind === 'folder') void dropNoteNode(event, node.id) },
    },
      element('button', {
        type: 'button', class: 'notes-tree-row', role: 'treeitem',
        'aria-selected': String(selected), 'aria-expanded': node.kind === 'folder' ? String(expanded) : undefined,
        onClick: () => { void selectNoteNode(node, { toggleFolder: node.kind === 'folder' }) },
      },
        node.kind === 'folder' ? element('span', { class: 'notes-tree-chevron', 'aria-hidden': 'true' }) : element('span', { class: 'notes-tree-spacer' }),
        renderNoteIcon(node),
        element('span', { class: 'notes-tree-name', title: node.name }, node.name),
      ),
      element('div', { class: 'notes-row-actions' },
        actionButton('重命名', event => { event.stopPropagation(); openRenameNoteNode(node) }, 'ghost tiny'),
        actionButton('复制', event => { event.stopPropagation(); void copyNoteNode(node) }, 'ghost tiny'),
        actionButton('删除', event => { event.stopPropagation(); void confirmDeleteNoteNode(node) }, 'ghost tiny danger-text'),
      ),
    )
    const children = expanded
      ? state.notes.loadedFolders.has(node.id)
        ? renderNoteTreeBranch(node.id, depth + 1)
        : element('div', { class: 'notes-tree-loading', role: 'status' }, '正在读取…')
      : null
    return element('div', { class: 'notes-tree-node' }, row, children)
  }))
}

function renderNoteSearchResults() {
  if (!state.notes.searchResults.length) return element('div', { class: 'notes-tree-empty' }, '没有匹配的笔记文档。')
  return element('div', { class: 'notes-search-results' }, state.notes.searchResults.map(node => element('button', {
    type: 'button', class: 'notes-search-row', 'data-knowledge-motion-key': `note-search:${node.id}`,
    onClick: () => { void selectNoteNode(node) },
  }, renderNoteIcon(node), element('span', {}, element('strong', {}, node.name), element('small', {}, noteKindLabel(node))))))
}

function renderNoteContent() {
  const node = state.notes.selectedNode
  if (!node) return renderNoteFolderContent(null)
  if (state.notes.loadingNodeId === node.id) return renderNoteSelectionLoading(node)
  if (node.kind === 'folder') return renderNoteFolderContent(node)
  if (node.kind === 'document') return renderNoteDocument(node)
  return renderNoteFile(node)
}

function renderNoteSelectionLoading(node) {
  return element('main', { class: `notes-content notes-selection-loading is-${node.kind}`, role: 'status', 'aria-label': `正在打开 ${node.name}` },
    element('header', { class: 'notes-content-header' },
      element('div', { class: 'notes-breadcrumb' }, element('span', {}, '笔记文档'), element('span', { 'aria-hidden': 'true' }, '/'), element('strong', {}, node.name)),
      element('div', { class: 'notes-content-title' }, element('div', {}, element('h2', {}, node.name), element('p', {}, node.kind === 'folder' ? '正在读取目录内容' : '正在按需读取文档内容'))),
    ),
    element('div', { class: 'notes-selection-skeleton', 'aria-hidden': 'true' },
      element('div', { class: 'skeleton-line skeleton-paper-title' }),
      ...Array.from({ length: node.kind === 'folder' ? 6 : 9 }, (_, index) => element('div', { class: `skeleton-line skeleton-paper-row is-${index % 4}` })),
    ),
  )
}

function renderNoteFolderContent(folder) {
  const parentId = folder?.id || null
  const children = state.notes.children.get(parentId || 'root') || []
  return element('main', {
    class: 'notes-content is-folder',
    onDragOver: event => event.preventDefault(),
    onDrop: event => void dropNoteNode(event, parentId),
  },
    renderNoteContentHeader(folder),
    children.length
      ? element('div', { class: 'notes-file-list', role: 'list' }, children.map(node => element('div', {
        class: 'notes-file-row', role: 'listitem', draggable: 'true',
        onDragStart: event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-dsh-note-id', node.id) },
        onDblClick: () => { void selectNoteNode(node, { toggleFolder: node.kind === 'folder' }) },
      },
        element('button', { type: 'button', class: 'notes-file-main', onClick: () => { void selectNoteNode(node) } },
          renderNoteIcon(node, true),
          element('span', {}, element('strong', {}, node.name), element('small', {}, noteKindLabel(node))),
        ),
        element('time', { datetime: node.updatedAt, 'data-label': '更新' }, formatDate(node.updatedAt)),
        element('span', { class: 'notes-file-size', 'data-label': node.kind === 'folder' ? '类型' : '大小' }, node.kind === 'folder' ? '目录' : formatBytes(node.size)),
        element('div', { class: 'notes-file-actions' },
          node.kind !== 'folder' ? noteDownloadButton(node, 'ghost tiny') : null,
          actionButton('重命名', () => openRenameNoteNode(node), 'ghost tiny'),
          actionButton('复制', () => { void copyNoteNode(node) }, 'ghost tiny'),
          actionButton('删除', () => { void confirmDeleteNoteNode(node) }, 'ghost tiny danger-text'),
        ),
      )))
      : element('div', { class: 'notes-folder-empty' },
        element('span', { class: 'notes-empty-folder-mark', 'aria-hidden': 'true' }),
        element('h3', {}, '这个目录还是空的'),
        element('p', {}, '可以新建笔记文档、建立子目录，或把本地文件拖到这里。'),
        element('div', {}, actionButton('新建文档', () => openCreateNoteDocument(parentId), 'primary small'), actionButton('新建目录', () => openCreateNoteFolder(parentId), 'small')),
      ),
  )
}

function renderNoteContentHeader(folder) {
  const path = folder ? [...state.notes.breadcrumbs] : []
  return element('header', { class: 'notes-content-header' },
    element('nav', { class: 'notes-breadcrumb', 'aria-label': '当前位置' },
      element('button', { type: 'button', onClick: () => { void openNoteRoot() } }, '笔记文档'),
      path.map(node => element('span', {}, element('span', { 'aria-hidden': 'true' }, '/'), element('button', { type: 'button', onClick: () => { void selectNoteNode(node) } }, node.name))),
    ),
    element('div', { class: 'notes-content-title' },
      element('div', {}, element('h2', {}, folder?.name || '全部笔记'), element('p', {}, folder ? `${(state.notes.children.get(folder.id) || []).length} 个项目` : '你的独立笔记与资料目录')),
      element('div', { class: 'notes-content-actions' },
        actionButton('新建文档', () => openCreateNoteDocument(folder?.id || null), 'primary small'),
        actionButton('新建目录', () => openCreateNoteFolder(folder?.id || null), 'small'),
      ),
    ),
  )
}

function renderNoteDocument(node) {
  return renderEditableNote(node)
}

function renderEditableNote(node) {
  const markdown = isMarkdownNote(node)
  const title = editableNoteTitle(node)
  const editor = markdown
    ? element('div', { class: 'notes-live-editor', role: 'status', 'aria-label': `正在打开 ${node.name}` },
      element('div', { class: 'notes-editor-loading' }, '正在打开文档…'))
    : createPlainTextNoteEditor(node)
  const scrollHost = element('div', { class: 'notes-document-scroll', 'data-scroll-key': `notes-document:${node.id}` },
    element('h1', {
      class: 'notes-document-title', contenteditable: 'plaintext-only', spellcheck: 'false',
      'aria-label': `修改 ${node.name} 的标题`, title: '点击修改标题',
      onBlur: event => { void saveEditableNoteTitle(event.currentTarget, node) },
      onKeyDown: event => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
        if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.textContent = title; event.currentTarget.blur() }
      },
    }, title),
    editor,
  )
  const outlineHost = markdown ? element('aside', { id: 'dsh-note-outline', class: 'notes-editor-outline', 'aria-label': '文档大纲', 'aria-hidden': 'true' }) : null
  const editorFrame = markdown
    ? element('div', { class: 'notes-editor-frame', 'data-outline-open': 'false', 'data-find-open': 'false' }, scrollHost, outlineHost)
    : scrollHost
  if (markdown) mountMarkdownNoteEditor(editor, node, editorFrame, scrollHost, outlineHost)
  else mountPlainTextNoteEditor(editor, node)
  return element('main', { class: `notes-content is-document${markdown ? '' : ' has-line-numbers'}` },
    renderNoteFileToolbar(node, { editable: true, enhanced: markdown }),
    editorFrame,
    renderNoteFileStatusbar(node),
  )
}

function editableNoteTitle(node) {
  return node.kind === 'document' ? node.name.replace(/\.md$/i, '') : node.name
}

async function saveEditableNoteTitle(editor, node) {
  const title = readPlainTextEditor(editor).replace(/\s+/g, ' ').trim()
  const name = node.kind === 'document' && title ? `${title.replace(/\.md$/i, '')}.md` : title
  if (!name) {
    editor.textContent = editableNoteTitle(node)
    showToast('标题不能为空。', 'error')
    return
  }
  if (name === node.name) {
    editor.textContent = editableNoteTitle(node)
    return
  }
  editor.setAttribute('contenteditable', 'false')
  try {
    const updated = await api(`notes/${encodeURIComponent(node.id)}`, { method: 'PATCH', body: { name } })
    if (state.notes.selectedNode?.id === node.id) state.notes.selectedNode = updated
    editor.textContent = editableNoteTitle(updated)
    const breadcrumb = document.querySelector('.notes-document-toolbar .notes-breadcrumb strong')
    if (breadcrumb) breadcrumb.textContent = updated.name
    await loadNoteChildren(updated.parentId, true).catch(() => {})
    const treeName = document.querySelector(`.notes-tree-item[data-note-id="${updated.id}"] .notes-tree-name`)
    if (treeName) treeName.textContent = updated.name
    showToast('标题已更新。')
  } catch (error) {
    editor.textContent = editableNoteTitle(node)
    showToast(friendlyError(error), 'error')
  } finally {
    if (editor.isConnected) editor.setAttribute('contenteditable', 'plaintext-only')
  }
}

function createPlainTextNoteEditor(node) {
  return element('div', { class: 'notes-plain-editor', role: 'status', 'aria-label': `正在打开 ${node.name}` },
    element('div', { class: 'notes-editor-loading' }, '正在打开文档…'))
}

function readPlainTextEditor(editor) {
  return editor.innerText.replace(/\r\n?/g, '\n')
}

function updateNoteDraft(value) {
  state.notes.draft = value
  state.notes.dirty = state.notes.draft !== state.notes.content
  syncNoteEditorChrome()
}

function mountMarkdownNoteEditor(host, node, frame, scrollHost, outlineHost) {
  mountMarkdownEditor(host, {
    frame,
    scrollHost,
    outlineHost,
    markdown: state.notes.draft,
    label: `编辑 ${node.name}`,
    isCurrent: () => state.notes.selectedNode?.id === node.id,
    onChange: updateNoteDraft,
    onSave: () => { void saveNoteDocument() },
  })
}

function mountPlainTextNoteEditor(host, node) {
  const request = ++plainTextEditorMountRequest
  window.requestAnimationFrame(async () => {
    if (!host.isConnected || state.notes.selectedNode?.id !== node.id || request !== plainTextEditorMountRequest) return
    try {
      const runtime = await loadMarkdownNoteEditor()
      if (!host.isConnected || state.notes.selectedNode?.id !== node.id || request !== plainTextEditorMountRequest) return
      host.replaceChildren()
      host.removeAttribute('role')
      plainTextEditorHandle = runtime.createPlainTextEditor({
        host,
        text: state.notes.draft,
        label: `编辑 ${node.name}`,
        onChange: updateNoteDraft,
        onSave: () => { void saveNoteDocument() },
      })
    } catch (error) {
      if (!host.isConnected || request !== plainTextEditorMountRequest) return
      host.replaceChildren(element('div', { class: 'notes-editor-error', role: 'alert' },
        element('strong', {}, '无法打开纯文本编辑器'),
        element('span', {}, friendlyError(error)),
        actionButton('重试', () => { noteEditorLoader = null; host.replaceChildren(); mountPlainTextNoteEditor(host, node) }, 'small')))
    }
  })
}

function mountMarkdownEditor(host, options) {
  const request = ++markdownEditorMountRequest
  window.requestAnimationFrame(async () => {
    if (!host.isConnected || options.isCurrent?.() === false || request !== markdownEditorMountRequest) return
    try {
      const runtime = await loadMarkdownNoteEditor()
      if (!host.isConnected || options.isCurrent?.() === false || request !== markdownEditorMountRequest) return
      host.replaceChildren()
      host.removeAttribute('role')
      markdownEditorHandle = runtime.createMarkdownEditor({
        host,
        ...(options.frame ? {
          frame: options.frame,
          scrollHost: options.scrollHost,
          outlineHost: options.outlineHost,
          findButton: host.closest('.notes-content')?.querySelector('[data-note-find]') || null,
          outlineButton: host.closest('.notes-content')?.querySelector('[data-note-outline]') || null,
        } : {}),
        markdown: options.markdown,
        label: options.label,
        onChange: options.onChange,
        onSave: options.onSave,
      })
    } catch (error) {
      if (!host.isConnected || request !== markdownEditorMountRequest) return
      host.replaceChildren(element('div', { class: 'notes-editor-error', role: 'alert' },
        element('strong', {}, '无法打开 Markdown 编辑器'),
        element('span', {}, friendlyError(error)),
        actionButton('重试', () => { noteEditorLoader = null; host.replaceChildren(); mountMarkdownEditor(host, options) }, 'small')))
    }
  })
}

function loadMarkdownNoteEditor() {
  if (window.DshKnowledgeNoteEditor?.createMarkdownEditor) return Promise.resolve(window.DshKnowledgeNoteEditor)
  if (noteEditorLoader) return noteEditorLoader
  noteEditorLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    const suffix = ASSET_VERSION ? `?v=${encodeURIComponent(ASSET_VERSION)}` : ''
    script.src = `${WEB_PATH.replace(/\/$/, '')}/note-editor.js${suffix}`
    script.async = true
    script.onload = () => window.DshKnowledgeNoteEditor?.createMarkdownEditor
      ? resolve(window.DshKnowledgeNoteEditor)
      : reject(new Error('Markdown 编辑器模块无效'))
    script.onerror = () => { script.remove(); reject(new Error('Markdown 编辑器加载失败')) }
    document.head.append(script)
  }).catch(error => {
    noteEditorLoader = null
    throw error
  })
  return noteEditorLoader
}

function releaseNoteEditors() {
  markdownEditorMountRequest += 1
  plainTextEditorMountRequest += 1
  markdownEditorHandle?.destroy()
  plainTextEditorHandle?.destroy()
  markdownEditorHandle = null
  plainTextEditorHandle = null
}

function syncNoteEditorChrome() {
  const status = document.querySelector('[data-note-save-state]')
  if (status) {
    status.textContent = state.notes.dirty ? '未保存' : '已保存'
    status.dataset.dirty = String(state.notes.dirty)
  }
  const save = document.querySelector('[data-note-save]')
  if (save) save.disabled = !state.notes.dirty
}

function renderNoteDocumentBreadcrumb(node) {
  return element('nav', { class: 'notes-breadcrumb', 'aria-label': '当前位置' },
    element('button', { type: 'button', onClick: () => { void openNoteRoot() } }, '笔记文档'),
    state.notes.breadcrumbs.map(parent => element('span', {}, element('span', { 'aria-hidden': 'true' }, '/'), element('button', { type: 'button', onClick: () => { void selectNoteNode(parent) } }, parent.name))),
    element('span', {}, element('span', { 'aria-hidden': 'true' }, '/'), element('strong', {}, node.name)),
  )
}

function renderNoteFile(node) {
  if (node.editable) return renderEditableNote(node)
  const previewKind = noteFilePreviewKind(node)
  let preview
  if (previewKind === 'image' && state.notes.assetUrl) {
    preview = element('img', { class: 'notes-inline-image', src: state.notes.assetUrl, alt: node.name })
  } else if (previewKind === 'pdf' && state.notes.assetUrl) {
    preview = element('iframe', { class: 'notes-inline-frame', src: state.notes.assetUrl, title: node.name })
  } else {
    preview = element('div', { class: 'notes-inline-unavailable' },
      renderNoteIcon(node, true),
      element('h2', {}, node.name),
      element('p', {}, '该格式不能在浏览器中直接编辑，可以下载后使用本地应用打开。'),
      noteDownloadButton(node, 'primary small', '下载文件'),
    )
  }
  return element('main', { class: 'notes-content is-file' },
    renderNoteFileToolbar(node),
    element('section', { class: `notes-inline-viewer is-${previewKind}`, 'aria-label': `${node.name}内容` }, preview),
    renderNoteFileStatusbar(node),
  )
}

function renderNoteFileToolbar(node, options = {}) {
  return element('header', { class: 'notes-document-toolbar' },
    element('div', { class: 'notes-toolbar-leading' },
      renderNoteDocumentBreadcrumb(node),
    ),
    element('div', { class: 'notes-document-actions' },
      options.editable ? element('span', { class: 'notes-save-state', role: 'status', 'data-note-save-state': '', 'data-dirty': String(state.notes.dirty) }, state.notes.dirty ? '未保存' : '已保存') : null,
      options.enhanced ? actionButton('查找', () => markdownEditorHandle?.openFind(), 'ghost small', { 'data-note-find': '', 'data-note-mobile-overflow': '', 'aria-keyshortcuts': 'Control+F Meta+F', 'aria-pressed': 'false' }) : null,
      options.enhanced ? actionButton('大纲', () => markdownEditorHandle?.toggleOutline(), 'ghost small', { 'data-note-outline': '', 'data-note-mobile-overflow': '', 'aria-controls': 'dsh-note-outline', 'aria-expanded': 'false', 'aria-pressed': 'false' }) : null,
      options.editable ? actionButton('历史', () => { void openNoteHistory(node) }, 'ghost small', { 'data-note-history': '', 'data-note-mobile-overflow': '' }) : null,
      noteDownloadButton(node, 'ghost small', '下载', { 'data-note-mobile-overflow': '' }),
      actionButton('复制引用', () => { void copyNoteReference(node) }, 'ghost small', { 'data-note-mobile-overflow': '' }),
      actionButton('重命名', () => openRenameNoteNode(node), 'ghost small', { 'data-note-mobile-overflow': '' }),
      options.editable ? actionButton('保存', () => { void saveNoteDocument() }, 'primary small', { 'data-note-save': '', 'data-note-mobile-overflow': '', disabled: !state.notes.dirty }) : null,
      renderNoteFileOverflowMenu(node, options),
    ),
  )
}

function renderNoteFileOverflowMenu(node, options) {
  const details = element('details', {
    class: 'notes-document-more',
    onKeyDown: event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      details.open = false
      summary.focus()
    },
    onFocusOut: () => {
      window.setTimeout(() => {
        if (!details.contains(document.activeElement)) details.open = false
      }, 0)
    },
  })
  const summary = element('summary', { class: 'button ghost small', title: '更多操作', 'aria-label': `打开 ${node.name} 的更多操作` },
    interfaceIcon('more', 'notes-document-more-icon'),
  )
  details.addEventListener('toggle', () => {
    summary.setAttribute('aria-expanded', String(details.open))
    summary.setAttribute('aria-label', `${details.open ? '关闭' : '打开'} ${node.name} 的更多操作`)
  })
  const closeThen = action => event => {
    details.open = false
    action(event)
  }
  const menuItems = []
  if (options.editable) {
    menuItems.push(noteMenuAction(state.notes.dirty ? '保存修改' : '已保存', 'save', closeThen(() => { void saveNoteDocument() }), { disabled: !state.notes.dirty }))
    menuItems.push(noteMenuDivider())
  }
  if (options.enhanced) {
    menuItems.push(noteMenuAction('查找', 'search', closeThen(() => markdownEditorHandle?.openFind())))
    menuItems.push(noteMenuAction('标题大纲', 'outline', closeThen(() => markdownEditorHandle?.toggleOutline())))
  }
  if (options.editable) menuItems.push(noteMenuAction('页面历史', 'history', closeThen(() => { void openNoteHistory(node) })))
  if (options.enhanced || options.editable) menuItems.push(noteMenuDivider())
  menuItems.push(
    noteMenuAction('下载', 'download', closeThen(event => { void downloadNoteFile(node, event.currentTarget) })),
    noteMenuAction('复制引用', 'link', closeThen(() => { void copyNoteReference(node) })),
    noteMenuAction('重命名', 'rename', closeThen(() => openRenameNoteNode(node))),
  )
  const menu = element('div', { class: 'notes-document-more-menu', role: 'menu', 'aria-label': `${node.name} 的更多操作` }, menuItems)
  summary.setAttribute('aria-expanded', 'false')
  details.append(summary, menu)
  return details
}

function noteMenuAction(label, icon, onClick, attributes = {}) {
  return actionButton([
    interfaceIcon(icon, 'notes-document-menu-icon'),
    element('span', { class: 'notes-document-menu-label' }, label),
  ], onClick, 'ghost small notes-document-menu-item', { role: 'menuitem', ...attributes })
}

function noteMenuDivider() {
  return element('div', { class: 'notes-document-menu-divider', role: 'separator' })
}

function renderNoteFileStatusbar(node) {
  return element('footer', { class: 'notes-document-statusbar', 'aria-label': '文档信息' },
    element('div', { class: 'notes-file-info' },
      noteInfoItem('编号', shortNoteId(node.id), node.id, 'id'),
      noteInfoItem('类型', node.kind === 'document' ? 'Markdown' : node.mediaType || '未知'),
      noteInfoItem('大小', formatBytes(node.size), '', 'size'),
      noteInfoItem('更新', formatDate(node.updatedAt), '', 'updated'),
    ),
  )
}

function noteInfoItem(label, value, title = '', key = '') {
  return element('span', { class: 'notes-file-info-item', title: title || value, ...(key ? { 'data-note-info': key } : {}) }, element('strong', {}, label), element('span', {}, value))
}

function renderNoteIcon(node, large = false) {
  const label = node.kind === 'folder' ? '' : noteExtension(node.name)
  return element('span', { class: `note-node-icon is-${node.kind}${large ? ' is-large' : ''}`, 'data-media-kind': noteMediaKind(node), 'aria-hidden': 'true' }, label)
}

function noteKindLabel(node) {
  if (node.kind === 'folder') return '目录'
  if (node.kind === 'document') return 'Markdown 笔记'
  return `${node.mediaType || '文件'}  ${formatBytes(node.size)}`
}

function isMarkdownNote(node) {
  return node.kind === 'document' || node.mediaType === 'text/markdown' || /\.(md|markdown)$/i.test(node.name)
}

function noteFilePreviewKind(node) {
  if (node.mediaType?.startsWith('image/')) return 'image'
  if (node.mediaType === 'application/pdf' || /\.pdf$/i.test(node.name)) return 'pdf'
  return 'unavailable'
}

async function selectNoteNode(node, options = {}) {
  if (state.notes.dirty && !await saveNoteDocument()) return
  const request = ++noteSelectionRequest
  releaseNoteAsset()
  state.notes.selectedId = node.id
  state.notes.selectedNode = node
  Object.assign(state.notes, { content: '', draft: '', dirty: false })
  state.notes.loadingNodeId = node.id
  renderShell()
  try {
    const breadcrumbs = await loadNoteBreadcrumbs(node)
    if (request !== noteSelectionRequest || state.notes.selectedId !== node.id) return
    state.notes.breadcrumbs = breadcrumbs
    if (node.kind === 'folder') {
      Object.assign(state.notes, { content: '', draft: '', dirty: false })
      state.notes.currentFolderId = node.id
      if (options.toggleFolder) {
        if (state.notes.expandedFolders.has(node.id)) state.notes.expandedFolders.delete(node.id)
        else state.notes.expandedFolders.add(node.id)
      }
      await loadNoteChildren(node.id)
    } else if (node.editable) {
      const blob = await binaryRequest(`notes/${encodeURIComponent(node.id)}/content`, { responseType: 'blob', accept: node.mediaType || 'text/plain' })
      const content = await blob.text()
      if (request !== noteSelectionRequest || state.notes.selectedId !== node.id) return
      state.notes.content = content
      state.notes.draft = content
      state.notes.dirty = false
      state.notes.currentFolderId = node.parentId
    } else {
      state.notes.content = ''
      state.notes.draft = ''
      state.notes.dirty = false
      state.notes.currentFolderId = node.parentId
      if (noteFilePreviewKind(node) !== 'unavailable') {
        const blob = await binaryRequest(`notes/${encodeURIComponent(node.id)}/content`, { responseType: 'blob', accept: node.mediaType || 'application/octet-stream' })
        if (request !== noteSelectionRequest || state.notes.selectedId !== node.id) return
        state.notes.assetUrl = URL.createObjectURL(blob)
      }
    }
  } catch (error) {
    if (request === noteSelectionRequest) showToast(friendlyError(error), 'error')
  } finally {
    if (request === noteSelectionRequest && state.notes.loadingNodeId === node.id) {
      state.notes.loadingNodeId = ''
      renderShell()
    }
  }
}

async function loadNoteChildren(parentId, force = false) {
  const key = parentId || 'root'
  if (!force && state.notes.loadedFolders.has(key)) return state.notes.children.get(key) || []
  const params = new URLSearchParams({ limit: '500' })
  if (parentId) params.set('parentId', parentId)
  const nodes = await api(`notes?${params}`)
  state.notes.children.set(key, nodes)
  state.notes.loadedFolders.add(key)
  return nodes
}

async function loadNoteBreadcrumbs(node) {
  const parents = []
  let parentId = node.parentId
  while (parentId) {
    const parent = findCachedNote(parentId) || await api(`notes/${encodeURIComponent(parentId)}`)
    parents.unshift(parent)
    parentId = parent.parentId
  }
  return node.kind === 'folder' ? [...parents, node] : parents
}

function findCachedNote(id) {
  for (const nodes of state.notes.children.values()) {
    const found = nodes.find(node => node.id === id)
    if (found) return found
  }
  return state.notes.selectedNode?.id === id ? state.notes.selectedNode : null
}

async function openNoteRoot() {
  if (state.notes.dirty && !await saveNoteDocument()) return
  noteSelectionRequest += 1
  clearNoteSelection()
  await loadNoteChildren(null)
  renderShell()
}

function clearNoteSelection() {
  releaseNoteAsset()
  Object.assign(state.notes, { selectedId: '', selectedNode: null, currentFolderId: null, breadcrumbs: [], content: '', draft: '', dirty: false, loadingNodeId: '' })
}

function releaseNoteAsset() {
  if (!state.notes?.assetUrl) return
  URL.revokeObjectURL(state.notes.assetUrl)
  state.notes.assetUrl = ''
}

function scheduleNoteSearch(value) {
  state.notes.query = value
  window.clearTimeout(noteSearchTimer)
  noteSearchController?.abort()
  noteSearchController = null
  const request = ++noteSearchRequest
  noteSearchTimer = window.setTimeout(async () => {
    const controller = new AbortController()
    noteSearchController = controller
    try {
      const results = value.trim()
        ? await api(`notes?q=${encodeURIComponent(value.trim())}&limit=200`, { signal: controller.signal })
        : []
      if (request !== noteSearchRequest || value !== state.notes.query) return
      state.notes.searchResults = results
      renderShell()
    } catch (error) {
      if (!controller.signal.aborted && request === noteSearchRequest) showToast(friendlyError(error), 'error')
    } finally {
      if (noteSearchController === controller) noteSearchController = null
    }
  }, 180)
}

function openCreateNoteFolder(parentId = state.notes.currentFolderId) {
  const field = formField('目录名称', 'text', '', { maxlength: 255, placeholder: '例如：项目资料' })
  const form = element('form', { class: 'form-grid' }, field.wrapper)
  openSheet({
    title: '新建目录', description: '目录可以继续包含子目录、笔记文档和任意文件。', body: form,
    primaryLabel: '创建目录', onPrimary: async () => {
      const node = await api('notes/folders', { method: 'POST', body: { name: field.input.value, parentId } })
      await loadNoteChildren(parentId, true)
      if (parentId) state.notes.expandedFolders.add(parentId)
      await selectNoteNode(node)
      return true
    },
  })
  field.input.focus()
}

function openCreateNoteDocument(parentId = state.notes.currentFolderId) {
  const field = formField('文档名称', 'text', '', { maxlength: 255, placeholder: '例如：部署记录' })
  const form = element('form', { class: 'form-grid' }, field.wrapper)
  openSheet({
    title: '新建笔记文档', description: '文档使用 Markdown 编辑，默认不会被 AI 检索或回写。', body: form,
    primaryLabel: '创建并编辑', onPrimary: async () => {
      const node = await api('notes/documents', { method: 'POST', body: { name: field.input.value, parentId } })
      await loadNoteChildren(parentId, true)
      if (parentId) state.notes.expandedFolders.add(parentId)
      await selectNoteNode(node)
      return true
    },
  })
  field.input.focus()
}

function openRenameNoteNode(node) {
  const field = formField('名称', 'text', node.name, { maxlength: 255 })
  openSheet({
    title: '重命名', description: '知识文档中的 @ 引用使用稳定编号，不会因改名失效。', body: element('form', { class: 'form-grid' }, field.wrapper),
    primaryLabel: '保存名称', onPrimary: async () => {
      const updated = await api(`notes/${encodeURIComponent(node.id)}`, { method: 'PATCH', body: { name: field.input.value } })
      await loadNoteChildren(node.parentId, true)
      if (state.notes.selectedId === node.id) await selectNoteNode(updated)
      else renderShell()
      showToast('名称已更新。')
      return true
    },
  })
  field.input.select()
}

async function copyNoteNode(node) {
  try {
    const copy = await api(`notes/${encodeURIComponent(node.id)}/copy`, { method: 'POST', body: {} })
    await loadNoteChildren(node.parentId, true)
    renderShell()
    showToast(`已创建“${copy.name}”。`)
  } catch (error) { showToast(friendlyError(error), 'error') }
}

async function dropNoteNode(event, parentId) {
  event.preventDefault()
  event.stopPropagation()
  clearNoteDragState()
  const id = event.dataTransfer.getData('application/x-dsh-note-id')
  if (!id) {
    if (hasDragType(event, 'Files')) await importDroppedNotes(event.dataTransfer, parentId)
    return
  }
  const node = findCachedNote(id)
  if (!node || id === parentId || node.parentId === parentId) return
  try {
    await api(`notes/${encodeURIComponent(id)}`, { method: 'PATCH', body: { parentId } })
    await Promise.all([loadNoteChildren(node.parentId, true), loadNoteChildren(parentId, true)])
    if (state.notes.selectedId === id) state.notes.selectedNode = await api(`notes/${encodeURIComponent(id)}`)
    renderShell()
    showToast('已移动到目标目录。')
  } catch (error) { showToast(friendlyError(error), 'error') }
}

async function uploadNoteFiles(files, parentId) {
  const summary = createNoteImportSummary()
  const plans = files.flatMap(file => createNoteFilePlan(file, summary))
  if (!plans.length) return showToast('没有可上传的文件，单文件上限为 64 MiB。', 'error')
  const transfer = beginNoteTransfer('uploading')
  if (!transfer) return
  prepareNoteTransfer(transfer, summary)
  try {
    await importNotePlans(plans, parentId, transfer)
    await loadNoteChildren(parentId, true)
    renderShell()
    completeNoteTransfer(transfer)
    showNoteImportResult(summary)
  } catch (error) {
    if (transfer.completedItems) await loadNoteChildren(parentId, true).catch(() => {})
    renderShell()
    failNoteTransfer(transfer, error)
    showToast(friendlyError(error), 'error')
  }
}

async function importDroppedNotes(dataTransfer, parentId) {
  const payload = captureNoteDropPayload(dataTransfer)
  if (!payload.entries.length) return uploadNoteFiles(payload.files, parentId)
  const transfer = beginNoteTransfer('scanning')
  if (!transfer) return
  const summary = createNoteImportSummary()
  try {
    const plans = []
    for (const entry of payload.entries) {
      const plan = await collectNoteEntry(entry, summary, transfer)
      if (plan) plans.push(plan)
    }
    if (!plans.length) {
      dismissNoteTransfer()
      showToast('没有可上传的内容，单文件上限为 64 MiB。', 'error')
      return
    }
    prepareNoteTransfer(transfer, summary)
    await importNotePlans(plans, parentId, transfer)
    await loadNoteChildren(parentId, true)
    if (parentId) state.notes.expandedFolders.add(parentId)
    renderShell()
    completeNoteTransfer(transfer)
    showNoteImportResult(summary)
  } catch (error) {
    await loadNoteChildren(parentId, true).catch(() => {})
    renderShell()
    failNoteTransfer(transfer, error)
    showToast(friendlyError(error), 'error')
  }
}

function createNoteImportSummary() {
  return { files: 0, folders: 0, skipped: 0, bytes: 0 }
}

function createNoteFilePlan(file, summary) {
  if (file.size > NOTE_MAX_FILE_SIZE) {
    summary.skipped += 1
    return []
  }
  summary.files += 1
  summary.bytes += file.size
  return [{ kind: 'file', name: file.name, file }]
}

function captureNoteDropPayload(dataTransfer) {
  const files = Array.from(dataTransfer?.files || [])
  const entries = Array.from(dataTransfer?.items || []).flatMap(item => {
    if (item.kind !== 'file' || typeof item.webkitGetAsEntry !== 'function') return []
    try {
      const entry = item.webkitGetAsEntry()
      return entry ? [entry] : []
    } catch {
      return []
    }
  })
  return { entries, files }
}

async function collectNoteEntry(entry, summary, transfer) {
  transfer.currentName = entry.name || ''
  transfer.scannedItems += 1
  scheduleNoteTransferSync()
  if (entry.isDirectory) {
    summary.folders += 1
    const children = []
    for (const child of await readNoteDirectoryEntries(entry)) {
      const plan = await collectNoteEntry(child, summary, transfer)
      if (plan) children.push(plan)
    }
    return { kind: 'folder', name: entry.name, children }
  }
  if (!entry.isFile) return null
  const file = await readNoteFileEntry(entry)
  return createNoteFilePlan(file, summary)[0] || null
}

async function importNotePlans(plans, parentId, transfer) {
  for (const plan of plans) {
    transfer.currentName = plan.name
    scheduleNoteTransferSync()
    if (plan.kind === 'folder') {
      const folder = await api('notes/folders', { method: 'POST', body: { name: plan.name, parentId } })
      transfer.completedItems += 1
      scheduleNoteTransferSync()
      await importNotePlans(plan.children, folder.id, transfer)
      continue
    }
    const settledBytes = transfer.loadedBytes
    await uploadNoteFile(plan.file, parentId, loaded => {
      transfer.loadedBytes = settledBytes + Math.min(loaded, plan.file.size)
      scheduleNoteTransferSync()
    })
    transfer.loadedBytes = settledBytes + plan.file.size
    transfer.completedItems += 1
    scheduleNoteTransferSync()
  }
}

async function readNoteDirectoryEntries(entry) {
  const reader = entry.createReader()
  const entries = []
  while (true) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
    if (!batch.length) return entries
    entries.push(...batch)
  }
}

function readNoteFileEntry(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

async function uploadNoteFile(file, parentId, onProgress) {
  const params = new URLSearchParams({ name: file.name })
  if (parentId) params.set('parentId', parentId)
  return binaryUploadRequest(`notes/files?${params}`, file, {
    method: 'POST', contentType: file.type || 'application/octet-stream', onProgress,
  })
}

function beginNoteTransfer(phase) {
  if (state.notes.transfer && ['scanning', 'uploading'].includes(state.notes.transfer.phase)) {
    showToast('已有导入任务正在进行，请稍候。', 'error')
    return null
  }
  const transfer = {
    id: String(++noteTransferSequence), phase, currentName: '', error: '',
    scannedItems: 0, completedItems: 0, totalItems: 0,
    loadedBytes: 0, totalBytes: 0, files: 0, folders: 0, skipped: 0,
  }
  state.notes.transfer = transfer
  refreshNoteTransferPanel()
  return transfer
}

function prepareNoteTransfer(transfer, summary) {
  transfer.phase = 'uploading'
  transfer.currentName = ''
  transfer.totalItems = summary.files + summary.folders
  transfer.totalBytes = summary.bytes
  transfer.files = summary.files
  transfer.folders = summary.folders
  transfer.skipped = summary.skipped
  scheduleNoteTransferSync()
}

function completeNoteTransfer(transfer) {
  if (state.notes.transfer !== transfer) return
  transfer.phase = 'complete'
  transfer.currentName = ''
  transfer.completedItems = transfer.totalItems
  transfer.loadedBytes = transfer.totalBytes
  refreshNoteTransferPanel()
  window.setTimeout(() => {
    if (state.notes.transfer === transfer && transfer.phase === 'complete') dismissNoteTransfer()
  }, 2600)
}

function failNoteTransfer(transfer, error) {
  if (state.notes.transfer !== transfer) return
  transfer.phase = 'error'
  transfer.error = friendlyError(error)
  refreshNoteTransferPanel()
}

function dismissNoteTransfer() {
  state.notes.transfer = null
  document.querySelector('.notes-transfer')?.remove()
}

function refreshNoteTransferPanel() {
  const current = document.querySelector('.notes-transfer')
  const panel = renderNoteTransfer()
  if (!panel) {
    current?.remove()
    return
  }
  if (current) current.replaceWith(panel)
  else document.querySelector('.notes-workspace')?.append(panel)
  syncNoteTransferPanel()
}

function scheduleNoteTransferSync() {
  if (noteTransferFrame) return
  noteTransferFrame = requestAnimationFrame(() => {
    noteTransferFrame = 0
    syncNoteTransferPanel()
  })
}

function syncNoteTransferPanel() {
  const transfer = state.notes.transfer
  const panel = document.querySelector('.notes-transfer')
  if (!transfer || !panel || panel.dataset.noteTransfer !== transfer.id) return
  const percent = noteTransferPercent(transfer)
  panel.dataset.state = transfer.phase
  panel.style.setProperty('--notes-transfer-progress', String(percent / 100))
  const title = panel.querySelector('.notes-transfer-title')
  const detail = panel.querySelector('.notes-transfer-detail')
  const count = panel.querySelector('.notes-transfer-count')
  const percentLabel = panel.querySelector('.notes-transfer-percent')
  const progress = panel.querySelector('.notes-transfer-track')
  if (title) title.textContent = noteTransferTitle(transfer)
  if (detail) {
    detail.textContent = noteTransferDetail(transfer)
    detail.title = transfer.currentName || ''
  }
  if (count) count.textContent = noteTransferCount(transfer)
  if (percentLabel) percentLabel.textContent = transfer.phase === 'scanning' ? '正在整理' : `${percent}%`
  if (progress) {
    if (transfer.phase === 'scanning') progress.removeAttribute('aria-valuenow')
    else progress.setAttribute('aria-valuenow', String(percent))
  }
}

function noteTransferPercent(transfer) {
  if (transfer.phase === 'complete') return 100
  const value = transfer.totalBytes > 0
    ? transfer.loadedBytes / transfer.totalBytes
    : transfer.totalItems > 0 ? transfer.completedItems / transfer.totalItems : 0
  return Math.min(transfer.phase === 'uploading' ? 99 : 100, Math.max(0, Math.round(value * 100)))
}

function noteTransferTitle(transfer) {
  if (transfer.phase === 'scanning') return '正在整理导入内容'
  if (transfer.phase === 'complete') return '导入完成'
  if (transfer.phase === 'error') return '导入未完成'
  return '正在导入笔记'
}

function noteTransferDetail(transfer) {
  if (transfer.phase === 'error') return transfer.error || '导入过程中发生错误'
  if (transfer.phase === 'complete') return `${transfer.files} 个文件、${transfer.folders} 个目录已写入`
  if (transfer.phase === 'scanning') return transfer.currentName || '正在读取文件和目录…'
  return transfer.currentName || '准备写入…'
}

function noteTransferCount(transfer) {
  if (transfer.phase === 'scanning') return `已读取 ${transfer.scannedItems} 项`
  const count = `${transfer.completedItems} / ${transfer.totalItems} 项`
  const bytes = transfer.totalBytes ? ` · ${formatBytes(transfer.loadedBytes)} / ${formatBytes(transfer.totalBytes)}` : ''
  const skipped = transfer.skipped ? ` · 跳过 ${transfer.skipped}` : ''
  return `${count}${bytes}${skipped}`
}

function showNoteImportResult(summary) {
  const added = [summary.folders ? `${summary.folders} 个目录` : '', summary.files ? `${summary.files} 个文件` : ''].filter(Boolean).join('、')
  const skipped = summary.skipped ? `，跳过 ${summary.skipped} 个超过 64 MiB 的文件` : ''
  showToast(`已添加${added ? ` ${added}` : ''}${skipped}。`)
}

async function saveNoteDocument() {
  const node = state.notes.selectedNode
  if (!node || !node.editable || !state.notes.dirty) return true
  try {
    const updated = await binaryRequest(`notes/${encodeURIComponent(node.id)}/content`, {
      method: 'PUT', body: new Blob([state.notes.draft], { type: node.mediaType || 'text/plain' }), contentType: node.mediaType || 'text/plain',
    })
    state.notes.selectedNode = updated
    state.notes.content = state.notes.draft
    state.notes.dirty = false
    await loadNoteChildren(node.parentId, true)
    const size = document.querySelector('[data-note-info="size"] > span')
    const updatedAt = document.querySelector('[data-note-info="updated"] > span')
    if (size) size.textContent = formatBytes(updated.size)
    if (updatedAt) updatedAt.textContent = formatDate(updated.updatedAt)
    syncNoteEditorChrome()
    showToast('文件已保存。')
    return true
  } catch (error) {
    showToast(friendlyError(error), 'error')
    return false
  }
}

async function openNoteHistory(node) {
  if (state.notes.selectedNode?.id === node.id && state.notes.dirty && !await saveNoteDocument()) return
  try {
    const current = state.notes.selectedNode?.id === node.id ? state.notes.selectedNode : await api(`notes/${encodeURIComponent(node.id)}`)
    if (!current?.editable) throw new Error('只有可编辑的笔记文档支持页面历史。')
    const versions = await api(`notes/${encodeURIComponent(node.id)}/versions?limit=100`)
    if (!versions.length) {
      showToast('这个文档还没有可查看的保存记录。')
      return
    }
    let modal
    const view = window.DshKnowledgeNoteHistory.createNoteHistoryView({
      versions,
      currentVersion: current.version,
      currentContent: state.notes.selectedNode?.id === node.id ? state.notes.content : '',
      loadContent: async (version, signal) => {
        const blob = await binaryRequest(`notes/${encodeURIComponent(node.id)}/versions/${version.version}/content`, {
          responseType: 'blob', accept: version.mediaType || 'text/plain', signal,
        })
        return blob.text()
      },
      renderPreview: content => renderHistoricalNotePreview(content, isMarkdownNote(current)),
      renderDiff: renderNoteHistoryDiff,
      formatDate,
      formatBytes,
      onRestore: async (version, content) => {
        const updated = await api(`notes/${encodeURIComponent(node.id)}/versions/${version.version}/restore`, {
          method: 'POST', body: { expectedVersion: current.version },
        })
        if (state.notes.selectedNode?.id === node.id) {
          state.notes.selectedNode = updated
          state.notes.content = content
          state.notes.draft = content
          state.notes.dirty = false
          await loadNoteChildren(updated.parentId, true)
        }
        modal?.close(true)
        renderShell()
        showToast(`已将版本 ${version.version} 恢复为新的版本 ${updated.version}。`)
      },
      onError: error => showToast(friendlyError(error), 'error'),
    })
    modal = openModal({
      title: `${current.name} · 页面历史`,
      description: '每次内容保存都会形成不可变快照；恢复历史不会删除当前版本。',
      body: view.element,
      cancelLabel: '关闭',
      onClose: () => view.destroy(),
    })
    modal.dialog.classList.add('note-history-dialog')
    modal.dialog.classList.remove('narrow')
  } catch (error) {
    showToast(friendlyError(error), 'error')
  }
}

function renderHistoricalNotePreview(content, markdown) {
  if (!markdown) return element('pre', { class: 'note-history-plain-preview', role: 'document' }, content || '（空文档）')
  const rendered = renderMarkdownPreview(content).cloneNode(true)
  rendered.classList.add('note-history-markdown-preview')
  rendered.querySelectorAll('a').forEach(link => {
    link.removeAttribute('href')
    link.removeAttribute('role')
    link.removeAttribute('tabindex')
    link.removeAttribute('title')
  })
  return rendered
}

function renderNoteHistoryDiff(historical, current) {
  const diff = window.DshKnowledgeReview.createLineDiff(historical, current)
  const lines = window.DshKnowledgeReview.compactDiffLines(diff.lines, 3)
  return element('section', { class: 'note-history-diff', 'aria-label': '历史版本与当前版本的逐行差异' },
    element('div', { class: 'note-history-diff-summary' },
      element('strong', {}, '历史版本 → 当前版本'),
      element('div', { class: 'diff-summary', 'aria-label': `新增 ${diff.additions} 行，删除 ${diff.deletions} 行` },
        element('span', { class: 'diff-stat additions' }, `+${diff.additions}`),
        element('span', { class: 'diff-stat deletions' }, `-${diff.deletions}`),
      ),
    ),
    diff.simplified ? element('div', { class: 'diff-notice' }, '内容较长，已使用有界的简化差异视图。') : null,
    element('div', { class: 'diff-viewer', role: 'table' },
      element('div', { class: 'diff-column-headings', role: 'row' },
        element('span', { role: 'columnheader' }, '旧'),
        element('span', { role: 'columnheader' }, '新'),
        element('span', { 'aria-hidden': 'true' }),
        element('span', { role: 'columnheader' }, '正文'),
      ),
      lines.length ? lines.map(renderDiffLine) : element('div', { class: 'diff-empty' }, '所选版本与当前内容相同。'),
    ),
  )
}

function noteDownloadButton(node, variant = 'ghost small', label = '下载', attributes = {}) {
  return actionButton(label, event => { void downloadNoteFile(node, event.currentTarget) }, variant, {
    'aria-label': `下载 ${node.name}`,
    title: `下载 ${node.name}`,
    ...attributes,
  })
}

async function downloadNoteFile(node, button) {
  const originalLabel = button?.textContent || ''
  if (button) {
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    button.textContent = '下载中'
  }
  try {
    if (state.notes.selectedNode?.id === node.id && state.notes.dirty && !await saveNoteDocument()) return
    const current = state.notes.selectedNode?.id === node.id ? state.notes.selectedNode : node
    const blob = await binaryRequest(`notes/${encodeURIComponent(current.id)}/content?download=1`, { responseType: 'blob', accept: current.mediaType || 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const anchor = element('a', { href: url, download: current.name })
    document.body.append(anchor); anchor.click(); anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    showToast(`已下载 ${current.name}。`)
  } catch (error) {
    showToast(`下载失败：${friendlyError(error)}`, 'error')
  } finally {
    if (button?.isConnected) {
      button.disabled = false
      button.removeAttribute('aria-busy')
      button.textContent = originalLabel
    }
  }
}

async function copyNoteReference(node) {
  try { await navigator.clipboard.writeText(noteReference(node)); showToast('笔记引用已复制。') }
  catch { showToast('复制失败，请手动复制文档编号。', 'error') }
}

async function confirmDeleteNoteNode(node) {
  try {
    const references = await api(`notes/${encodeURIComponent(node.id)}/references`)
    if (references.length) {
      const names = references.slice(0, 4).map(item => `“${item.documentTitle}”`).join('、')
      return openModal({
        title: '仍被知识文档引用', description: node.name,
        body: element('p', {}, `${names}${references.length > 4 ? `等 ${references.length} 篇文档` : ''}仍在引用这里的内容。请先移除引用，再删除。`),
        cancelLabel: '知道了',
      })
    }
    openConfirm({
      title: `删除“${node.name}”？`,
      message: node.kind === 'folder' ? '目录及其全部子目录和文件会被永久删除。' : '该文档会被永久删除，此操作无法撤销。',
      confirmLabel: '永久删除', danger: true,
      onConfirm: async () => {
        await api(`notes/${encodeURIComponent(node.id)}`, { method: 'DELETE' })
        await loadNoteChildren(node.parentId, true)
        if (state.notes.selectedId === node.id || state.notes.breadcrumbs.some(parent => parent.id === node.id)) clearNoteSelection()
        renderShell(); showToast('已删除。')
      },
    })
  } catch (error) { showToast(friendlyError(error), 'error') }
}

function noteWorkspaceDragEnter(event) {
  if (!hasDragType(event, 'Files')) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  event.currentTarget.dataset.dropActive = 'true'
}

function noteWorkspaceDragLeave(event) {
  if (event.currentTarget.contains(event.relatedTarget)) return
  clearNoteDragState()
}

function activateNoteFolderDropTarget(event, node) {
  if (node.kind !== 'folder') return
  const hasFiles = hasDragType(event, 'Files')
  if (!hasFiles && !hasDragType(event, 'application/x-dsh-note-id')) return
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = hasFiles ? 'copy' : 'move'
  const workspace = document.querySelector('.notes-workspace')
  if (workspace) workspace.dataset.dropActive = 'false'
  document.querySelectorAll('.notes-tree-item[data-drop-target="true"]').forEach(target => {
    if (target !== event.currentTarget) target.dataset.dropTarget = 'false'
  })
  event.currentTarget.dataset.dropTarget = 'true'
}

function hasDragType(event, type) {
  return Array.from(event.dataTransfer?.types || []).includes(type)
}

function clearNoteDragState() {
  const workspace = document.querySelector('.notes-workspace')
  if (workspace) workspace.dataset.dropActive = 'false'
  document.querySelectorAll('.notes-tree-item[data-drop-target="true"]').forEach(node => { node.dataset.dropTarget = 'false' })
  document.querySelectorAll('.notes-tree-item[data-dragging="true"]').forEach(node => { node.dataset.dragging = 'false' })
}

function installDragRecovery() {
  const clear = () => {
    clearNoteDragState()
    clearKnowledgeDocumentDragState()
  }
  window.addEventListener('drop', clear, true)
  window.addEventListener('dragend', clear, true)
  window.addEventListener('blur', clear)
  document.addEventListener('dragleave', event => {
    if (event.relatedTarget === null) clear()
  }, true)
}

function noteReference(node) {
  const label = node.name.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]')
  return `@[${label}](note://${node.id})`
}

function noteMediaKind(node) {
  if (node.kind === 'folder') return 'folder'
  if (node.kind === 'document' || node.mediaType?.startsWith('text/')) return 'text'
  if (node.mediaType?.startsWith('image/')) return 'image'
  if (node.mediaType === 'application/pdf') return 'pdf'
  return 'file'
}

function noteExtension(name) {
  const extension = name.includes('.') ? name.split('.').pop() : 'FILE'
  return extension.slice(0, 4).toLocaleUpperCase()
}

function shortNoteId(id) {
  return `${id.slice(0, 11)}…${id.slice(-5)}`
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB`
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MiB`
}

function renderCandidates() {
  const statuses = [['pending', '待审核'], ['approved', '已通过'], ['rejected', '已拒绝']]
  const pendingCount = state.stats?.candidates.pending ?? state.candidates.filter(candidate => candidate.status === 'pending').length
  return element('section', { class: 'candidate-page', 'aria-labelledby': 'candidates-heading' },
    element('div', { class: 'section-heading' },
      element('div', {}, element('h2', { id: 'candidates-heading' }, 'AI 提取候选'), element('p', {}, '审核写入、模型推断、低置信度结果和冲突项会在这里等待确认；只有高置信度且证据明确的结果才能直接写入。')),
      element('div', { class: 'candidate-heading-actions' },
        state.candidateStatus === 'pending' ? actionButton(state.candidateBatchRunning ? '正在通过…' : '一键通过', openBulkApprove, 'primary', {
          disabled: state.candidateBatchRunning || pendingCount === 0,
          title: pendingCount === 0 ? '当前没有待审核候选' : '分批通过新增与可安全合并项，冲突项会保留',
          'aria-busy': String(state.candidateBatchRunning),
        }) : null,
        element('div', { class: 'tabs', role: 'tablist', 'aria-label': '候选状态' }, statuses.map(([value, label]) => element('button', {
          type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(state.candidateStatus === value),
          onClick: async () => { state.candidateStatus = value; await navigate('candidates') },
        }, label, state.stats ? ` ${state.stats.candidates[value]}` : ''))),
      ),
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
          candidate.change?.kind === 'revise' ? badge('原文修订', 'warning') : candidate.change?.kind === 'append' ? badge('内容补充') : null, ' ',
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
            : target ? `${candidate.change?.kind === 'revise' ? '修订' : '补充到'}“${target.title}”` : `目标 ${candidate.targetId || '不可用'}`),
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
        action.manualOnly ? null : actionButton(action.label, () => reviewCandidate(candidate, 'approve', action.resolution), 'primary small', {
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
  const review = window.DshKnowledgeReview.createReviewChange(candidate.action, target?.body || '', candidate.draft.body, candidate.change?.kind)
  const title = candidate.action === 'create'
    ? '新文档内容'
    : candidate.action === 'conflict' ? '冲突处理预览' : candidate.change?.kind === 'revise' ? '原文修订预览' : '内容补充预览'
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
  if (candidate.action === 'conflict' && candidate.change?.kind !== 'revise') {
    return { label: '需要手动解决', editLabel: '手动解决', resolution: 'merge', manualOnly: true }
  }
  if (candidate.action === 'conflict') return {
    label: candidate.change?.kind === 'revise' ? '应用冲突修订' : '确认补充',
    editLabel: '手动解决', resolution: 'merge',
  }
  if (candidate.change?.kind === 'revise') return { label: '应用修订', editLabel: '编辑修订结果' }
  return { label: '补充到文档', editLabel: '编辑后补充' }
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

async function openKnowledgeBaseEditor(base) {
  await loadModelCatalog()
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
  const dedicatedModel = element('input', {
    type: 'checkbox',
    checked: Boolean(source.writebackProvider && source.writebackModel),
  })
  const route = modelRouteFields(source.writebackProvider || '', source.writebackModel || '')
  const routeToggle = element('label', { class: 'check-option span-2' }, dedicatedModel,
    element('span', {},
      element('strong', {}, '这个知识库使用专用回写模型'),
      element('small', {}, '未设置时先使用本机覆盖；本机也未设置时跟随当前会话模型。'),
    ))
  const syncRouteAvailability = () => {
    route.provider.input.disabled = route.model.input.disabled = !dedicatedModel.checked
    route.provider.input.required = route.model.input.required = dedicatedModel.checked
  }
  dedicatedModel.addEventListener('change', syncRouteAvailability)
  syncRouteAvailability()
  for (const field of [name, description, tags, instructions]) field.wrapper.classList.add('span-2')
  form.append(
    name.wrapper, description.wrapper, tags.wrapper, instructions.wrapper, policy.wrapper,
    routeToggle, route.provider.wrapper, route.model.wrapper,
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
        ...(dedicatedModel.checked ? {
          writebackProvider: route.provider.input.value,
          writebackModel: route.model.input.value,
        } : {}),
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
    ? window.DshKnowledgeReview.createReviewChange(candidate.action, candidateTarget?.body || '', candidate.draft.body, candidate.change?.kind)
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
    ? candidate.action === 'create' ? '编辑新文档' : '编辑最终文档'
    : entry ? '编辑知识文档' : '新建知识文档'
  const candidateDescription = candidate?.action === 'create'
    ? '确认后将创建文档并立即参与后续召回。'
    : '正文是审核后的最终版本；可以直接修改、删除过时内容。若原文已变化，会要求重新打开后处理。'
  const primaryLabel = candidate
    ? candidate.action === 'create' ? '写入新文档' : '保存最终版本'
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
      method: 'POST', body: {
        decision: 'approve', draft,
        ...(candidateTarget?.version ? { expectedVersion: candidateTarget.version } : {}),
        ...(candidate.action === 'conflict' ? { resolution: 'merge' } : {}),
      },
    })
    else if (entry) await api(`entries/${encodeURIComponent(entry.id)}`, { method: 'PUT', body: { draft } })
    else await api('entries', { method: 'POST', body: { draft } })
    showToast(candidate ? candidate.action === 'create' ? '新文档已写入。' : '文档修订已保存。' : '知识已保存。')
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
    const response = await fetch('/knowledge-control/v1/models', {
      headers: { accept: 'application/json', 'x-dsh-knowledge-client': 'management-web' },
    })
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
        ? candidate.change?.kind === 'revise'
          ? '确认后会按预览替换或删除原文。请重点核对红色删除行和绿色新增行。'
          : '确认后会保留当前文档，并补充候选内容。'
        : candidate.change?.kind === 'revise'
          ? '确认后会按预览修订原文；无关的并发补充会被保留，同一区域变化会转为冲突。'
          : '确认后将按预览补充目标文档；若出现矛盾会转为冲突项。'
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
      showToast(approve ? candidate.action === 'create' ? '新文档已写入。' : candidate.change?.kind === 'revise' ? '原文已修订。' : '内容已补充。' : '候选已拒绝。')
      state.stats = null
      await navigate('candidates')
    },
  })
}

function openBulkApprove() {
  if (state.candidateBatchRunning) return
  const pendingCount = state.stats?.candidates.pending ?? state.candidates.length
  const summary = element('strong', {}, `准备处理 ${pendingCount} 条待审核候选`)
  const detail = element('p', {}, '开始后会按创建时间分批处理，并实时显示结果。')
  const metrics = element('div', { class: 'bulk-review-metrics' })
  const status = element('div', {
    class: 'bulk-review-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', hidden: true,
  }, summary, detail, metrics)
  const body = element('div', { class: 'bulk-review-confirm' },
    element('p', {}, '将分批通过待审核中的新增与可安全合并项。冲突项、目标不可用项，以及审核期间发生变化的候选会保留，供你逐条处理。'),
    element('div', { class: 'bulk-review-safety' },
      element('strong', {}, '不会自动处理冲突'),
      element('span', {}, '同一文档的候选会按时间顺序写入，避免并发覆盖。'),
    ),
    status,
  )
  openModal({
    title: '一键通过待审核候选？',
    description: '适合集中处理积压候选；操作完成后无法批量撤销。',
    body,
    primaryLabel: '开始一键通过',
    onPrimary: async () => {
      state.candidateBatchRunning = true
      status.hidden = false
      const excluded = new Set()
      const totals = { approved: 0, deferred: 0, failed: 0, selected: 0, remainingReviewable: pendingCount, remainingManual: 0 }
      const updateProgress = (message = '正在按顺序审核候选…') => {
        summary.textContent = message
        detail.textContent = `已检查 ${totals.selected} 条；每批最多 25 条。`
        metrics.replaceChildren(
          bulkReviewMetric('已通过', totals.approved, 'success'),
          bulkReviewMetric('转为冲突', totals.deferred, 'warning'),
          bulkReviewMetric('失败保留', totals.failed, totals.failed ? 'danger' : ''),
          bulkReviewMetric('剩余可处理', totals.remainingReviewable),
        )
      }
      updateProgress()
      try {
        for (let pass = 0; pass < 1000; pass += 1) {
          const result = await api('candidates/bulk-review', {
            method: 'POST', body: { limit: 25, excludeIds: [...excluded] },
          })
          totals.selected += result.selected
          totals.approved += result.approved
          totals.deferred += result.deferred
          totals.failed += result.failed.length
          totals.remainingReviewable = result.remainingReviewable
          totals.remainingManual = result.remainingManual
          result.failed.forEach(item => excluded.add(item.id))
          updateProgress()
          if (result.remainingReviewable === 0) break
          if (result.selected === 0) throw new Error('批量审核没有继续推进；剩余候选已保留，请刷新后重试。')
        }
        if (totals.remainingReviewable > 0) throw new Error('待审核候选过多，本次处理已达到安全上限，请再次执行。')
        summary.textContent = totals.approved > 0 ? `已通过 ${totals.approved} 条候选` : '没有可自动通过的候选'
        detail.textContent = totals.remainingManual > 0
          ? `仍有 ${totals.remainingManual} 条冲突或失败项保留，需逐条确认。`
          : '待审核队列已处理完成。'
        state.stats = null
        await loadCandidates()
        state.candidateBatchRunning = false
        renderShell()
        const parts = [`已通过 ${totals.approved} 条`]
        if (totals.deferred) parts.push(`${totals.deferred} 条转为冲突`)
        if (totals.failed) parts.push(`${totals.failed} 条失败并保留`)
        if (totals.remainingManual) parts.push(`${totals.remainingManual} 条待人工处理`)
        showToast(`${parts.join('，')}。`, totals.failed ? 'error' : '')
        return true
      } finally {
        state.candidateBatchRunning = false
      }
    },
  })
}

function bulkReviewMetric(label, value, variant = '') {
  return element('span', { class: `bulk-review-metric ${variant}`.trim() },
    element('small', {}, label), element('strong', {}, String(value)),
  )
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
    element('div', { class: 'field span-2' }, element('label', {}, '权限'), element('div', { class: 'check-grid' }, checkboxes.map(item => item.node)), element('span', { class: 'field-hint' }, '普通客户端建议只授予 read + propose。write 是当前中央服务的全局写权限，同时允许直接写入、管理知识库、挂载和笔记；仅在确实需要时授予。')))
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

function openModal({ title, description = '', body, primaryLabel, primaryVariant = 'primary', onPrimary, cancelLabel = '取消', presentation = 'modal', onClose }) {
  const previouslyFocused = document.activeElement
  const isSheet = presentation === 'sheet'
  const backdrop = element('div', { class: `dialog-backdrop${isSheet ? ' sheet-backdrop' : ''}` })
  const dialog = element('section', { class: `dialog${isSheet ? ' sheet' : ''} ${primaryLabel ? '' : 'narrow'}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title' })
  let busy = false
  let formDirty = false
  let closed = false
  const close = (explicit = false) => {
    if (busy || closed) return
    if (!explicit && formDirty) {
      showToast('表单有未保存的修改，请先保存，或使用“取消”放弃修改。', 'error')
      return
    }
    document.removeEventListener('keydown', onKeyDown)
    closed = true
    backdrop.remove()
    refreshWorkspaceEffects()
    onClose?.()
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
  }
  const closeButton = actionButton('×', () => close(), 'ghost', { 'aria-label': '关闭对话框' })
  const cancel = actionButton(cancelLabel, () => close(true))
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
      if (shouldClose !== false) close(true)
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
  if (body.matches?.('form') || body.querySelector?.('form')) {
    body.addEventListener('input', () => { formDirty = true })
    body.addEventListener('change', () => { formDirty = true })
  }
  document.body.append(backdrop)
  refreshWorkspaceEffects(backdrop)
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

window.addEventListener('beforeunload', event => {
  const editor = activeDocumentWorkspace()?.view.editor
  if (!editor?.dirty && !state.notes.dirty) return
  event.preventDefault()
  event.returnValue = ''
})

installDragRecovery()
void installHostThemeBridge().then(() => boot())
