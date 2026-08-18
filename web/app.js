const API_BASE = document.querySelector('meta[name="dsh-knowledge-api"]')?.content || '/knowledge-api/v1'
const AUTH_MODE = document.querySelector('meta[name="dsh-knowledge-auth-mode"]')?.content || 'bearer'
const TOKEN_KEY = 'dsh-knowledge.session-token'
const TYPES = ['preference', 'fact', 'decision', 'procedure', 'lesson']
const TYPE_LABELS = { preference: '偏好', fact: '事实', decision: '决策', procedure: '流程', lesson: '经验' }
const ACTION_LABELS = { create: '新增', update: '更新', conflict: '冲突' }
const STATUS_LABELS = { active: '生效中', archived: '已归档', pending: '待审核', approved: '已通过', rejected: '已拒绝' }
const CHANGE_LABELS = { create: '创建', update: '更新', archive: '归档', restore: '恢复' }
const WRITE_MODE_LABELS = { none: '仅召回', audit: '审核写入', direct: '直接写入' }
const TYPE_DOCUMENTS = {
  preference: 'preferences.md', fact: 'facts.md', decision: 'decisions.md', procedure: 'procedures.md', lesson: 'lessons.md',
}
const DOCUMENT_LAYOUT_KEY = 'dsh-knowledge.document-layout'
const DOCUMENT_COLUMN_LAYOUTS = Object.freeze({
  library: {
    widthKey: 'libraryWidth', hiddenKey: 'libraryHidden', cssVariable: '--library-width',
    minimum: 170, maximum: 360, controls: 'knowledge-library-column',
  },
  documentList: {
    widthKey: 'documentListWidth', hiddenKey: 'documentListHidden', cssVariable: '--document-list-width',
    minimum: 210, maximum: 480, controls: 'document-list-column',
  },
})
const pageParams = new URLSearchParams(location.search)
const mountContext = {
  sessionId: pageParams.get('sessionId')?.trim() || '',
  projectId: pageParams.get('projectId')?.trim() || '',
}
const app = document.querySelector('#app')
const toastRegion = document.querySelector('#toast-region')
const savedDocumentLayout = readDocumentLayout()

const state = {
  token: sessionStorage.getItem(TOKEN_KEY) || '',
  view: 'overview',
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
  documentView: {
    knowledgeBaseId: '', documentId: '', query: '', mode: 'documents',
    sidebarHidden: savedDocumentLayout.sidebarHidden,
    libraryHidden: savedDocumentLayout.libraryHidden,
    documentListHidden: savedDocumentLayout.documentListHidden,
    sidebarWidth: savedDocumentLayout.sidebarWidth,
    libraryWidth: savedDocumentLayout.libraryWidth,
    documentListWidth: savedDocumentLayout.documentListWidth,
  },
  candidates: [],
  candidateStatus: 'pending',
  tokens: [],
  service: { publicApiEnabled: false, publicApiPrefix: '/knowledge-api/v1', remote: false },
  scrollPositions: new Map(),
  loading: false,
  error: '',
}

let scrollRestoreFrame = 0

function readDocumentLayout() {
  const fallback = {
    sidebarHidden: false, libraryHidden: false, documentListHidden: false,
    sidebarWidth: 236, libraryWidth: 220, documentListWidth: 280,
  }
  try {
    const value = JSON.parse(localStorage.getItem(DOCUMENT_LAYOUT_KEY) || '{}')
    return {
      sidebarHidden: value.sidebarHidden === true,
      libraryHidden: value.libraryHidden === true,
      documentListHidden: value.documentListHidden === true,
      sidebarWidth: clampNumber(value.sidebarWidth, 190, 340, fallback.sidebarWidth),
      libraryWidth: clampNumber(value.libraryWidth, 170, 360, fallback.libraryWidth),
      documentListWidth: clampNumber(value.documentListWidth, 210, 480, fallback.documentListWidth),
    }
  } catch { return fallback }
}

function saveDocumentLayout() {
  try {
    localStorage.setItem(DOCUMENT_LAYOUT_KEY, JSON.stringify({
      sidebarHidden: state.documentView.sidebarHidden,
      libraryHidden: state.documentView.libraryHidden,
      documentListHidden: state.documentView.documentListHidden,
      sidebarWidth: state.documentView.sidebarWidth,
      libraryWidth: state.documentView.libraryWidth,
      documentListWidth: state.documentView.documentListWidth,
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
  state.scrollPositions.set(shell.dataset.view, {
    window: { left: window.scrollX, top: window.scrollY },
    regions,
  })
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
    await navigate('overview')
    return
  }
  if (!state.token) {
    renderLogin()
    return
  }
  try {
    await api('entries?limit=1')
    await navigate('overview')
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
        await navigate('overview')
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
  Object.assign(state, { token: '', stats: null, overview: null, knowledgeBases: [], mounts: [], resolvedMounts: [], entries: [], documents: [], candidates: [], tokens: [] })
  if (AUTH_MODE === 'same-origin') void boot()
  else renderLogin()
}

async function navigate(view) {
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
  const requests = [api('knowledge-bases'), api('mounts')]
  if (state.mountContext.sessionId) {
    const params = new URLSearchParams({ sessionId: state.mountContext.sessionId })
    if (state.mountContext.projectId) params.set('projectId', state.mountContext.projectId)
    requests.push(api(`mounts/resolve?${params}`))
  }
  const [bases, mounts, resolved = []] = await Promise.all(requests)
  state.knowledgeBases = bases
  state.mounts = mounts
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
  const [bases, documents] = await Promise.all([api('knowledge-bases'), api('documents')])
  state.knowledgeBases = bases
  state.documents = documents
  const view = state.documentView
  const availableBaseIds = new Set(bases.map(base => base.id))
  if (!view.knowledgeBaseId || !availableBaseIds.has(view.knowledgeBaseId)) {
    view.knowledgeBaseId = state.entryFilters.knowledgeBaseId && availableBaseIds.has(state.entryFilters.knowledgeBaseId)
      ? state.entryFilters.knowledgeBaseId
      : bases.find(base => base.status === 'active')?.id || bases[0]?.id || ''
  }
  selectDefaultDocument()
  if (!state.stats) await refreshStats()
}

function selectDefaultDocument() {
  const view = state.documentView
  const documents = state.documents.filter(document => document.knowledgeBaseId === view.knowledgeBaseId)
  if (!documents.some(document => document.id === view.documentId)) {
    view.documentId = documents.find(document => document.relPath === 'README.md')?.id || documents[0]?.id || ''
  }
}

async function loadCandidates() {
  const [candidates] = await Promise.all([
    api(`candidates?status=${state.candidateStatus}&limit=100`),
    ensureKnowledgeBases(),
  ])
  state.candidates = candidates
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
    bases: ['知识库', '创建知识库，并限定项目与会话的召回和写入范围'],
    entries: ['文档', '按知识库浏览自动整理的 Markdown 文档'],
    candidates: ['审核', '确认 AI 提取结果后再写入知识库'],
    tokens: ['访问管理', '管理其他客户端连接中央知识库的权限'],
  }
  const [title, subtitle] = titles[state.view]
  const shell = element('div', {
    class: 'app-shell', 'data-menu-open': String(state.menuOpen),
    'data-view': state.view, 'data-loading': String(state.loading),
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
          element('div', {}, element('h1', {}, title), element('p', {}, subtitle)),
        ),
        state.view === 'entries' && state.documentView.mode === 'documents' ? renderDocumentColumnControls() : null,
      ),
      element('div', { class: 'page' }, renderCurrentView()),
    ),
  )
  if (state.menuOpen) shell.addEventListener('click', (event) => {
    if (event.target === shell) { state.menuOpen = false; renderShell() }
  })
  app.replaceChildren(shell)
  restoreScrollPosition(state.view)
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
    ['工作区', [['overview', '概览'], ['bases', '知识库'], ['entries', '文档'], ['candidates', '审核']]],
    ['服务', [['tokens', '访问管理']].filter(([id]) => id !== 'tokens' || !state.service.remote)],
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
  const contextAvailable = Boolean(state.mountContext.projectId || state.mountContext.sessionId)
  const query = state.knowledgeBaseQuery.trim().toLocaleLowerCase()
  const matchesQuery = base => !query || [base.name, base.description, base.defaultTags.join(' '), base.writebackProvider, base.writebackModel]
    .some(value => String(value || '').toLocaleLowerCase().includes(query))
  const visibleActiveBases = activeBases.filter(matchesQuery)
  const visibleArchivedBases = archivedBases.filter(matchesQuery)
  const switcher = element('div', { class: 'workspace-switcher' },
    element('div', { class: 'tabs workspace-tabs', role: 'tablist', 'aria-label': '知识库管理范围' }, [
      ['libraries', '知识库', activeBases.length],
      ['mounts', '项目与会话挂载', state.mounts.filter(mount => mount.enabled).length],
    ].map(([id, label, count]) => element('button', {
      type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(state.knowledgeBaseView === id),
      onClick: () => { state.knowledgeBaseView = id; renderShell() },
    }, element('span', {}, label), element('span', { class: 'tab-count' }, count)))),
    element('p', {}, state.knowledgeBaseView === 'libraries'
      ? '管理知识库本身、标签和回写规则'
      : '决定当前项目或会话可以召回、审核或直接写入哪些知识库'),
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
          placeholder: '搜索名称、描述、标签或模型', 'aria-label': '搜索知识库',
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
          ? emptyState('没有匹配的知识库', '尝试搜索名称、描述、标签或回写模型。')
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
      element('span', {}, element('strong', {}, '回写模型'), base.writebackProvider && base.writebackModel ? `${base.writebackProvider} / ${base.writebackModel}` : '跟随当前会话'),
      base.extractionInstructions ? element('span', {}, element('strong', {}, '提取规则'), '已设置') : null,
    ),
    element('div', { class: 'base-card-actions' },
      actionButton('查看知识', () => {
        state.entryFilters.knowledgeBaseId = base.id
        state.documentView.knowledgeBaseId = base.id
        state.documentView.documentId = ''
        state.documentView.mode = 'documents'
        void navigate('entries')
      }, 'ghost small'),
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
    const model = base.writebackProvider && base.writebackModel ? `${base.writebackProvider} ${base.writebackModel}` : '跟随会话'
    const searchable = `${base.name} ${base.description} ${base.defaultTags.join(' ')} ${model}`.toLowerCase()
    return (!query || searchable.includes(query)) && (manager.filter === 'all' || manager.filter === view.statusKey)
  })
  const visibleIds = visibleRows.map(({ base }) => base.id)
  const selectedCount = manager.selectedIds.size
  const searchInput = element('input', {
    class: 'input', type: 'search', value: manager.query,
    placeholder: '搜索名称、描述、标签或模型', 'aria-label': '搜索可挂载知识库',
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
  const modelLabel = base.writebackProvider && base.writebackModel
    ? `${base.writebackProvider} / ${base.writebackModel}`
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
  if (state.documentView.mode === 'entries') return renderLegacyEntries()
  const view = state.documentView
  const query = view.query.trim().toLocaleLowerCase()
  const activeBases = state.knowledgeBases.filter(base => base.status === 'active')
  const selectedBase = state.knowledgeBases.find(base => base.id === view.knowledgeBaseId)
  const allBaseDocuments = state.documents.filter(document => document.knowledgeBaseId === view.knowledgeBaseId)
  const visibleDocuments = allBaseDocuments.filter(document => !query || [document.title, document.relPath, document.content]
    .some(value => value.toLocaleLowerCase().includes(query)))
  const selectedDocument = state.documents.find(document => document.id === view.documentId)
  const search = element('input', {
    class: 'input', type: 'search', value: view.query, placeholder: '搜索文档标题、路径或正文', 'aria-label': '搜索知识库文档',
    onInput: (event) => {
      view.query = event.target.value
      const stillVisible = state.documents.some(document => document.id === view.documentId
        && document.knowledgeBaseId === view.knowledgeBaseId
        && (!view.query.trim() || [document.title, document.relPath, document.content].some(value => value.toLocaleLowerCase().includes(view.query.trim().toLocaleLowerCase()))))
      if (!stillVisible) view.documentId = ''
      renderShell()
      document.querySelector('.document-global-search input')?.focus()
    },
  })
  if (!view.documentId && visibleDocuments.length) view.documentId = visibleDocuments[0].id
  const currentDocument = state.documents.find(document => document.id === view.documentId) || selectedDocument

  return element('section', { class: 'document-page', 'aria-labelledby': 'documents-heading' },
    element('div', { class: 'document-page-toolbar' },
      element('div', { class: 'search-box document-global-search' }, interfaceIcon('search', 'search-symbol'), search),
      element('select', {
        class: 'select compact-library-picker', 'aria-label': '选择知识库', value: view.knowledgeBaseId,
        onChange: (event) => { view.knowledgeBaseId = event.target.value; view.documentId = ''; selectDefaultDocument(); renderShell() },
      }, activeBases.map(base => element('option', { value: base.id, selected: base.id === view.knowledgeBaseId }, base.name))),
      element('div', { class: 'tabs', role: 'tablist', 'aria-label': '知识视图' },
        documentViewTab('文档', 'documents'), documentViewTab('条目管理', 'entries')),
      element('div', { class: 'document-toolbar-actions' },
        actionButton('视图设置', openLayoutEditor, 'small', { 'aria-label': '设置导航与文档栏的显示和宽度' }),
        actionButton('+ 新建知识', () => openEntryEditor(), 'primary'),
      ),
    ),
    element('div', {
      class: 'document-browser',
      'data-library-hidden': String(view.libraryHidden),
      'data-document-list-hidden': String(view.documentListHidden),
      style: `--library-width:${view.libraryWidth}px;--document-list-width:${view.documentListWidth}px`,
    },
      element('aside', { id: 'knowledge-library-column', class: 'knowledge-library-column', 'aria-label': '知识库列表' },
        element('header', { class: 'column-header' },
          element('div', {}, element('h2', { id: 'documents-heading' }, '知识库'), element('span', {}, `${activeBases.length} 个可用`)),
        ),
        activeBases.length ? element('div', { class: 'library-list', role: 'listbox', tabindex: '0', 'data-scroll-key': 'library-list', onKeyDown: event => moveDocumentSelection(event, 'base') },
          activeBases.map(base => {
            const documentCount = state.documents.filter(document => document.knowledgeBaseId === base.id).length
            const selected = base.id === view.knowledgeBaseId
            return element('button', {
              type: 'button', class: 'library-row', role: 'option', 'aria-selected': String(selected),
              onClick: () => { view.knowledgeBaseId = base.id; view.documentId = ''; selectDefaultDocument(); renderShell() },
            }, element('span', { class: 'library-dot', 'aria-hidden': 'true' }), element('span', { class: 'library-row-copy' },
              element('strong', {}, base.name), element('small', {}, base.description || '通用知识库')),
            element('span', { class: 'library-count', 'aria-label': `${documentCount} 篇文档` }, documentCount))
          })) : compactEmpty('还没有知识库'),
        element('footer', { class: 'column-footer' }, actionButton('+ 新建知识库', () => openKnowledgeBaseEditor(), 'ghost small')),
      ),
      renderColumnResizer('library', '调整知识库栏宽度'),
      element('aside', { id: 'document-list-column', class: 'document-list-column', 'aria-label': '文档列表' },
        element('header', { class: 'column-header' },
          element('div', {}, element('h2', {}, selectedBase?.name || '文档'), element('span', {}, query ? `找到 ${visibleDocuments.length} 篇` : `${allBaseDocuments.length} 篇文档`)),
        ),
        visibleDocuments.length ? element('div', { class: 'document-list', role: 'listbox', tabindex: '0', 'data-scroll-key': 'document-list', onKeyDown: event => moveDocumentSelection(event, 'document') },
          visibleDocuments.map(document => element('button', {
            type: 'button', class: 'document-row', role: 'option', 'aria-selected': String(document.id === view.documentId),
            onClick: () => { view.documentId = document.id; renderShell() },
          }, element('span', { class: 'document-icon', 'aria-hidden': 'true' }, document.relPath === 'README.md' ? '▣' : '≡'),
          element('span', { class: 'document-row-copy' }, element('strong', {}, document.title), element('small', {}, document.relPath)),
          element('span', { class: 'document-entry-count' }, document.entryCount))))
          : element('div', { class: 'document-empty' }, query ? '没有匹配的文档' : '这个知识库还没有文档'),
      ),
      renderColumnResizer('documentList', '调整文档栏宽度'),
      renderDocumentReader(currentDocument, selectedBase),
    ),
  )
}

function setDocumentColumnHidden(column, hidden) {
  if (column === 'library') state.documentView.libraryHidden = hidden
  else state.documentView.documentListHidden = hidden
  saveDocumentLayout()
  renderShell()
}

function renderDocumentColumnControls() {
  return element('div', { class: 'document-column-controls', role: 'group', 'aria-label': '显示文档栏位' },
    element('span', { class: 'document-column-controls-label', 'aria-hidden': 'true' }, '显示'),
    documentColumnControl('library', '知识库栏'),
    documentColumnControl('documentList', '文档栏'),
  )
}

function documentColumnControl(column, label) {
  const layout = DOCUMENT_COLUMN_LAYOUTS[column]
  const visible = !state.documentView[layout.hiddenKey]
  const action = `${visible ? '收起' : '展开'}${label}`
  return element('button', {
    type: 'button', class: 'document-column-control', 'data-column': column,
    'aria-label': action, 'aria-pressed': String(visible), title: action,
    onClick: () => setDocumentColumnHidden(column, visible),
  }, label)
}

function renderColumnResizer(column, label) {
  const layout = DOCUMENT_COLUMN_LAYOUTS[column]
  const hidden = state.documentView[layout.hiddenKey]
  if (hidden) return null
  const value = state.documentView[layout.widthKey]
  return element('div', {
    class: 'column-resizer', 'data-column': column, role: 'separator', tabindex: '0',
    title: `${label}；可拖动或使用左右方向键`,
    'aria-label': label, 'aria-controls': layout.controls, 'aria-orientation': 'vertical',
    'aria-valuemin': layout.minimum, 'aria-valuemax': layout.maximum, 'aria-valuenow': value,
    'aria-valuetext': `${value} 像素`,
    onPointerDown: event => startColumnResize(event, column),
    onKeyDown: event => resizeColumnWithKeyboard(event, column),
  }, element('span', { 'aria-hidden': 'true' }, '⋮'))
}

function openLayoutEditor() {
  const fields = [
    layoutRangeField('主导航栏', state.documentView.sidebarWidth, 190, 340),
    layoutRangeField('知识库二级栏', state.documentView.libraryWidth, 170, 360),
    layoutRangeField('文档列表栏', state.documentView.documentListWidth, 210, 480),
  ]
  const visibility = [
    layoutVisibilityOption('显示主导航栏', !state.documentView.sidebarHidden),
    layoutVisibilityOption('显示知识库二级栏', !state.documentView.libraryHidden),
    layoutVisibilityOption('显示文档列表栏', !state.documentView.documentListHidden),
  ]
  const reset = actionButton('恢复默认布局', () => {
    const defaults = [236, 220, 280]
    fields.forEach((field, index) => field.setValue(defaults[index]))
    visibility.forEach(option => { option.input.checked = true })
  }, 'ghost small')
  const body = element('div', { class: 'layout-editor' },
    element('div', { class: 'layout-visibility', 'aria-label': '边栏显示设置' }, visibility.map(option => option.wrapper)),
    fields.map(field => field.wrapper),
    element('div', { class: 'layout-editor-note' },
      element('span', {}, '拖动栏与栏之间的分隔线可调整宽度；收起和展开请使用文档标题栏的栏位开关。窗口过窄时会自动切换为紧凑布局。'),
      reset,
    ),
  )
  openModal({
    title: '调整边栏宽度',
    description: '分别设置管理导航、知识库二级栏和文档列表栏。',
    body,
    primaryLabel: '应用布局',
    onPrimary: async () => {
      state.documentView.sidebarHidden = !visibility[0].input.checked
      state.documentView.libraryHidden = !visibility[1].input.checked
      state.documentView.documentListHidden = !visibility[2].input.checked
      state.documentView.sidebarWidth = fields[0].value()
      state.documentView.libraryWidth = fields[1].value()
      state.documentView.documentListWidth = fields[2].value()
      saveDocumentLayout()
      renderShell()
      showToast('边栏宽度已保存。')
      return true
    },
  })
}

function layoutVisibilityOption(label, checked) {
  const input = element('input', { type: 'checkbox', checked })
  return {
    input,
    wrapper: element('label', { class: 'check-option' }, input, element('span', {}, element('strong', {}, label))),
  }
}

function layoutRangeField(label, value, minimum, maximum) {
  const output = element('output', { class: 'range-value' }, `${value}px`)
  const input = element('input', {
    type: 'range', min: minimum, max: maximum, step: '10', value,
    'aria-label': label,
    onInput: event => { output.textContent = `${event.target.value}px` },
  })
  return {
    wrapper: element('div', { class: 'field' },
      element('div', { class: 'layout-range-label' }, element('label', {}, label), output),
      element('div', { class: 'range-row' }, input),
    ),
    value: () => Number(input.value),
    setValue: next => { input.value = String(next); output.textContent = `${next}px` },
  }
}

function startColumnResize(event, column) {
  if (event.button !== 0) return
  event.preventDefault()
  const layout = DOCUMENT_COLUMN_LAYOUTS[column]
  const handle = event.currentTarget
  const browser = handle.closest('.document-browser')
  if (!browser) return
  const startX = event.clientX
  const startWidth = state.documentView[layout.widthKey]
  handle.setPointerCapture?.(event.pointerId)
  handle.classList.add('is-dragging')
  document.body.classList.add('is-resizing-columns')
  const move = moveEvent => {
    const width = clampNumber(startWidth + moveEvent.clientX - startX, layout.minimum, layout.maximum, startWidth)
    setDocumentColumnWidth(column, width, browser, handle)
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

function resizeColumnWithKeyboard(event, column) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const layout = DOCUMENT_COLUMN_LAYOUTS[column]
  const current = state.documentView[layout.widthKey]
  const browser = event.currentTarget.closest('.document-browser')
  const width = event.key === 'Home' ? layout.minimum
    : event.key === 'End' ? layout.maximum
    : clampNumber(current + (event.key === 'ArrowRight' ? 16 : -16), layout.minimum, layout.maximum, current)
  setDocumentColumnWidth(column, width, browser, event.currentTarget)
  saveDocumentLayout()
}

function setDocumentColumnWidth(column, width, browser, handle) {
  const layout = DOCUMENT_COLUMN_LAYOUTS[column]
  state.documentView[layout.widthKey] = width
  browser?.style.setProperty(layout.cssVariable, `${width}px`)
  handle?.setAttribute('aria-valuenow', String(width))
  handle?.setAttribute('aria-valuetext', `${width} 像素`)
}

function documentViewTab(label, mode) {
  return element('button', {
    type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(state.documentView.mode === mode),
    onClick: async () => {
      state.documentView.mode = mode
      if (mode === 'entries') await loadEntries()
      else await loadDocuments()
      renderShell()
    },
  }, label)
}

function moveDocumentSelection(event, kind) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return
  const view = state.documentView
  const values = kind === 'base'
    ? state.knowledgeBases.filter(base => base.status === 'active').map(base => base.id)
    : state.documents.filter(document => document.knowledgeBaseId === view.knowledgeBaseId).map(document => document.id)
  const current = kind === 'base' ? view.knowledgeBaseId : view.documentId
  if (event.key === 'Enter') return
  event.preventDefault()
  const index = Math.max(0, values.indexOf(current))
  const next = event.key === 'ArrowDown' ? Math.min(values.length - 1, index + 1) : Math.max(0, index - 1)
  if (!values[next]) return
  if (kind === 'base') { view.knowledgeBaseId = values[next]; view.documentId = ''; selectDefaultDocument() }
  else view.documentId = values[next]
  renderShell()
  document.querySelector(kind === 'base' ? '.library-list' : '.document-list')?.focus()
}

function renderDocumentReader(document, base) {
  if (!document) return element('main', { class: 'document-reader document-reader-empty' },
    element('div', {}, element('strong', {}, '选择一篇文档'), element('p', {}, '文档内容会在这里显示。')))
  return element('main', { class: 'document-reader', 'aria-labelledby': 'document-reader-title' },
    element('header', { class: 'reader-toolbar' },
      element('div', { class: 'reader-title' }, element('span', {}, base?.name || document.knowledgeBaseId), element('strong', { id: 'document-reader-title' }, document.relPath)),
      element('select', {
        class: 'select mobile-document-picker', 'aria-label': '选择文档',
        onChange: (event) => { state.documentView.documentId = event.target.value; renderShell() },
      }, state.documents.filter(item => item.knowledgeBaseId === document.knowledgeBaseId)
        .map(item => element('option', { value: item.id, selected: item.id === document.id }, item.relPath))),
      element('div', { class: 'reader-actions' }, badge(`${document.entryCount} 条知识`), actionButton('添加内容', () => openEntryEditor(), 'small')),
    ),
    element('article', { class: 'markdown-document', 'data-scroll-key': 'document-reader' }, renderMarkdown(document.content)),
    element('footer', { class: 'reader-footer' },
      element('span', {}, `自动整理 · ${formatDate(document.updatedAt)}`),
      element('span', {}, `SHA-256 · ${document.contentHash.slice(0, 8)}`),
    ),
  )
}

function renderMarkdown(markdown) {
  const nodes = []
  const lines = markdown.replaceAll('\r\n', '\n').split('\n')
  let paragraph = []
  let list = []
  let code = []
  let inCode = false
  const flushParagraph = () => {
    if (paragraph.length) nodes.push(element('p', {}, paragraph.join(' ')))
    paragraph = []
  }
  const flushList = () => {
    if (list.length) nodes.push(element('ul', {}, list.map(item => element('li', {}, item))))
    list = []
  }
  const flushCode = () => {
    if (code.length) nodes.push(element('pre', {}, element('code', {}, code.join('\n'))))
    code = []
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.startsWith('```')) {
      flushParagraph(); flushList()
      if (inCode) flushCode()
      inCode = !inCode
      continue
    }
    if (inCode) { code.push(raw); continue }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line)
    const bullet = /^[-*]\s+(.+)$/.exec(line)
    if (heading) {
      flushParagraph(); flushList()
      nodes.push(element(`h${heading[1].length}`, {}, heading[2]))
    } else if (line.startsWith('> ')) {
      flushParagraph(); flushList()
      nodes.push(element('blockquote', {}, line.slice(2)))
    } else if (bullet) {
      flushParagraph(); list.push(bullet[1])
    } else if (!line.trim()) {
      flushParagraph(); flushList()
    } else if (/^<small>.*<\/small>$/.test(line.trim())) {
      flushParagraph(); flushList()
      nodes.push(element('small', { class: 'markdown-metadata' }, line.trim().replace(/^<small>|<\/small>$/g, '')))
    } else paragraph.push(line.trim())
  }
  flushParagraph(); flushList(); flushCode()
  return nodes
}

function renderLegacyEntries() {
  const queryInput = element('input', { class: 'input', type: 'search', value: state.entryFilters.query, placeholder: '搜索标题、正文或标签', 'aria-label': '搜索知识' })
  const projectInput = element('input', { class: 'input', value: state.entryFilters.projectId, placeholder: '项目路径（可选）', 'aria-label': '按项目路径筛选' })
  const applyFilters = async () => {
    state.entryFilters.query = queryInput.value
    state.entryFilters.projectId = projectInput.value
    state.loading = true
    renderShell()
    try { await loadEntries() } catch (error) { state.error = friendlyError(error) } finally { state.loading = false; renderShell() }
  }
  const toolbar = element('form', { class: 'toolbar', onSubmit: (event) => { event.preventDefault(); void applyFilters() } },
    element('div', { class: 'search-box' }, element('span', { class: 'search-symbol', 'aria-hidden': 'true' }, '⌕'), queryInput),
    selectControl('状态', [{ value: 'active', label: '生效中' }, { value: 'archived', label: '已归档' }], state.entryFilters.status, (value) => { state.entryFilters.status = value; void applyFilters() }),
    selectControl('类型', [{ value: '', label: '全部类型' }, ...TYPES.map(type => ({ value: type, label: TYPE_LABELS[type] }))], state.entryFilters.type, (value) => { state.entryFilters.type = value; void applyFilters() }),
    selectControl('知识库', [{ value: '', label: '全部知识库' }, ...state.knowledgeBases.map(base => ({ value: base.id, label: base.name }))], state.entryFilters.knowledgeBaseId, (value) => { state.entryFilters.knowledgeBaseId = value; void applyFilters() }),
    projectInput,
    actionButton('搜索', () => {}, 'primary', { type: 'submit' }),
  )
  return element('section', { 'aria-labelledby': 'entries-heading' },
    element('div', { class: 'section-heading' }, element('div', {}, element('h2', { id: 'entries-heading' }, `${STATUS_LABELS[state.entryFilters.status]} · ${state.entries.length}`), element('p', {}, '搜索范围会包含全局知识和指定项目知识'))),
    toolbar,
    state.entries.length
      ? element('div', { class: 'card-grid' }, state.entries.map(renderEntryCard))
      : emptyState('没有匹配的知识', '调整筛选条件，或者手动创建第一条知识。', '新建知识', () => openEntryEditor()),
    state.nextCursor ? element('div', { class: 'loading' }, actionButton('加载更多', async () => {
      const cursor = state.nextCursor
      state.nextCursor = null
      try { await loadEntries(cursor); renderShell() } catch (error) { showToast(friendlyError(error), 'error') }
    })) : null,
  )
}

function renderEntryCard(entry) {
  const archived = entry.status === 'archived'
  return element('article', { class: 'knowledge-card' },
    element('div', { class: 'card-top' },
      element('div', {}, badge(knowledgeBaseName(entry.knowledgeBaseId)), ' ', badge(TYPE_LABELS[entry.type], 'accent'), ' ', archived ? badge('已归档') : badge('生效中', 'success')),
      element('span', { class: 'field-hint' }, `v${entry.version}`),
    ),
    element('h3', {}, entry.title),
    element('p', {}, entry.body),
    entry.tags.length ? element('div', { class: 'tag-row', 'aria-label': '标签' }, entry.tags.map(tag => element('span', { class: 'tag' }, `#${tag}`))) : null,
    element('div', { class: 'card-footer' },
      element('span', { class: 'field-hint' }, `${scopeLabel(entry.scope)} · ${formatDate(entry.updatedAt)}`),
      element('div', { class: 'card-actions' },
        actionButton('历史', () => openHistory(entry), 'ghost small'),
        actionButton(archived ? '编辑并恢复' : '编辑', () => openEntryEditor(entry), 'ghost small'),
        !archived ? actionButton('归档', () => confirmArchive(entry), 'ghost small') : actionButton('彻底删除', () => confirmDelete(entry), 'danger small'),
      ),
    ),
  )
}

function renderCandidates() {
  const statuses = [['pending', '待审核'], ['approved', '已通过'], ['rejected', '已拒绝']]
  return element('section', { 'aria-labelledby': 'candidates-heading' },
    element('div', { class: 'section-heading' },
      element('div', {}, element('h2', { id: 'candidates-heading' }, 'AI 提取候选'), element('p', {}, '审核写入的结果与冲突项会在这里等待确认；直接写入的普通结果会自动生效。')),
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
  const targetDocument = TYPE_DOCUMENTS[candidate.draft.type] || 'README.md'
  return element('article', { class: 'candidate' },
    element('div', { class: 'candidate-header' },
      element('div', {},
        element('div', {}, badge(knowledgeBaseName(candidate.draft.knowledgeBaseId)), ' ', badge(ACTION_LABELS[candidate.action], candidate.action === 'conflict' ? 'warning' : 'accent'), ' ', badge(TYPE_LABELS[candidate.draft.type])),
        element('h3', {}, candidate.draft.title),
      ),
      badge(STATUS_LABELS[candidate.status], candidate.status === 'approved' ? 'success' : candidate.status === 'rejected' ? 'danger' : 'warning'),
    ),
    element('div', { class: 'candidate-body' },
      element('p', { class: 'candidate-content' }, candidate.draft.body),
      element('div', { class: 'candidate-reason' },
        element('strong', {}, '文档变更'),
        element('span', { class: 'candidate-target' }, `将${candidate.action === 'create' ? '追加' : '更新'}到 ${targetDocument}`),
        element('strong', {}, '模型判断依据'), candidate.reason || '未提供判断说明'),
    ),
    element('div', { class: 'candidate-footer' },
      element('small', {}, `${scopeLabel(candidate.draft.scope)} · 置信度 ${Math.round(candidate.draft.confidence * 100)}%${candidate.targetId ? ` · 目标 ${candidate.targetId}` : ''} · ${formatDate(candidate.createdAt)}`),
      pending ? element('div', {},
        actionButton('拒绝', () => reviewCandidate(candidate, 'reject'), 'danger small'),
        actionButton('编辑并通过', () => openEntryEditor(undefined, candidate), 'small'),
        actionButton('通过', () => reviewCandidate(candidate, 'approve'), 'primary small'),
      ) : null,
    ),
  )
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
  const source = base || { name: '', description: '', defaultTags: [], extractionInstructions: '' }
  const form = element('form', { class: 'form-grid' })
  const name = formField('名称', 'input', source.name, { required: true, maxlength: 100, placeholder: '例如：项目规范' })
  const description = formField('回写匹配描述', 'textarea', source.description, { maxlength: 2000, placeholder: '描述什么样的对话才属于这个库。例如：只记录 dsh-knowledge 项目的架构决策和部署规范' })
  const tags = formField('默认标签', 'input', source.defaultTags.join(', '), { placeholder: 'project-rule, backend' })
  const instructions = formField('提取要求', 'textarea', source.extractionInstructions, { maxlength: 4000, placeholder: '例如：只收录已确认、可跨会话复用的项目约定' })
  const customModel = element('input', { type: 'checkbox', checked: Boolean(source.writebackProvider && source.writebackModel) })
  const provider = formField('模型提供方（Provider）', 'input', source.writebackProvider || '', { maxlength: 100, placeholder: '例如：cli' })
  const model = formField('模型名称（Model）', 'input', source.writebackModel || '', { maxlength: 200, placeholder: '例如：kimi-k2.7-code' })
  const modelHint = element('div', { class: 'field-hint span-2' }, '默认跟随当前会话模型。指定后，仅这个知识库使用专用模型回写。')
  const updateModelFields = () => {
    provider.input.disabled = !customModel.checked
    model.input.disabled = !customModel.checked
    provider.input.required = customModel.checked
    model.input.required = customModel.checked
  }
  customModel.addEventListener('change', updateModelFields)
  updateModelFields()
  for (const field of [name, description, tags, instructions]) field.wrapper.classList.add('span-2')
  form.append(
    name.wrapper, description.wrapper, tags.wrapper, instructions.wrapper,
    element('label', { class: 'check-option span-2' }, customModel, element('span', {},
      element('strong', {}, '为这个知识库指定回写模型'),
      element('small', {}, '关闭时自动使用当前会话正在使用的模型。'),
    )),
    provider.wrapper, model.wrapper, modelHint,
  )
  openModal({
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
        writebackProvider: customModel.checked ? provider.input.value.trim() : '',
        writebackModel: customModel.checked ? model.input.value.trim() : '',
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
  openModal({
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
  openModal({
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
      if (state.entryFilters.knowledgeBaseId === base.id) state.entryFilters.knowledgeBaseId = ''
      showToast('知识库及其全部关联数据已永久删除。')
      await navigate('bases')
      return true
    },
  })
  confirmation.input.focus()
}

function openEntryEditor(entry, candidate) {
  const source = candidate?.draft || entry || {
    knowledgeBaseId: state.documentView.knowledgeBaseId || undefined,
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
  const modeTitle = candidate ? '编辑并通过候选' : entry ? '编辑知识' : '新建知识'
  const modal = openModal({ title: modeTitle, description: candidate ? '保存后，这条候选会立即通过并写入知识库。' : '知识保存后会立即参与后续召回。', body: form, primaryLabel: candidate ? '通过并保存' : '保存', onPrimary: async () => {
    if (!form.reportValidity()) return false
    const draft = {
      knowledgeBaseId: knowledgeBase.input.value,
      title: title.input.value.trim(), body: body.input.value.trim(), type: type.input.value,
      tags: parseTags(tags.input.value),
      scope: scope.input.value === 'global' ? { kind: 'global' } : { kind: 'project', id: project.input.value.trim() },
      confidence: Number(confidenceInput.value),
      ...(source.source ? { source: source.source } : {}),
    }
    if (candidate) await api(`candidates/${encodeURIComponent(candidate.id)}/review`, { method: 'POST', body: { decision: 'approve', draft } })
    else if (entry) await api(`entries/${encodeURIComponent(entry.id)}`, { method: 'PUT', body: { draft } })
    else await api('entries', { method: 'POST', body: { draft } })
    showToast(candidate ? '候选已通过并写入知识库。' : '知识已保存。')
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

async function reviewCandidate(candidate, decision) {
  const approve = decision === 'approve'
  openConfirm({
    title: approve ? '通过这条候选？' : '拒绝这条候选？',
    message: approve ? '通过后内容会立即写入知识库，并参与后续对话召回。' : '拒绝后会保留审核记录，但不会进入知识库。',
    confirmLabel: approve ? '确认通过' : '确认拒绝', danger: !approve,
    onConfirm: async () => {
      await api(`candidates/${encodeURIComponent(candidate.id)}/review`, { method: 'POST', body: { decision } })
      showToast(approve ? '候选已通过。' : '候选已拒绝。')
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

function openModal({ title, description = '', body, primaryLabel, primaryVariant = 'primary', onPrimary, cancelLabel = '取消' }) {
  const previouslyFocused = document.activeElement
  const backdrop = element('div', { class: 'dialog-backdrop' })
  const dialog = element('section', { class: `dialog ${primaryLabel ? '' : 'narrow'}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title' })
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

void boot()
