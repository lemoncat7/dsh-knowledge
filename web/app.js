const API_BASE = document.querySelector('meta[name="dsh-knowledge-api"]')?.content || '/knowledge-api/v1'
const TOKEN_KEY = 'dsh-knowledge.session-token'
const TYPES = ['preference', 'fact', 'decision', 'procedure', 'lesson']
const TYPE_LABELS = { preference: '偏好', fact: '事实', decision: '决策', procedure: '流程', lesson: '经验' }
const ACTION_LABELS = { create: '新增', update: '更新', conflict: '冲突' }
const STATUS_LABELS = { active: '生效中', archived: '已归档', pending: '待审核', approved: '已通过', rejected: '已拒绝' }
const CHANGE_LABELS = { create: '创建', update: '更新', archive: '归档', restore: '恢复' }
const WRITE_MODE_LABELS = { none: '仅召回', audit: '审核写入', direct: '直接写入' }
const pageParams = new URLSearchParams(location.search)
const mountContext = {
  sessionId: pageParams.get('sessionId')?.trim() || '',
  projectId: pageParams.get('projectId')?.trim() || '',
}
const app = document.querySelector('#app')
const toastRegion = document.querySelector('#toast-region')

const state = {
  token: sessionStorage.getItem(TOKEN_KEY) || '',
  view: 'overview',
  menuOpen: false,
  stats: null,
  overview: null,
  knowledgeBases: [],
  mounts: [],
  resolvedMounts: [],
  mountContext,
  entries: [],
  nextCursor: null,
  entryFilters: { query: '', type: '', status: 'active', projectId: '', knowledgeBaseId: '' },
  candidates: [],
  candidateStatus: 'pending',
  tokens: [],
  loading: false,
  error: '',
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
  Object.assign(state, { token: '', stats: null, overview: null, knowledgeBases: [], mounts: [], resolvedMounts: [], entries: [], candidates: [], tokens: [] })
  renderLogin()
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
    if (view === 'entries') await loadEntries()
    if (view === 'candidates') await loadCandidates()
    if (view === 'tokens') await loadTokens()
  } catch (error) {
    if (error.status === 401) return signOut()
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

async function loadCandidates() {
  const [candidates] = await Promise.all([
    api(`candidates?status=${state.candidateStatus}&limit=100`),
    ensureKnowledgeBases(),
  ])
  state.candidates = candidates
  if (!state.stats) await refreshStats()
}

async function loadTokens() {
  state.tokens = await api('tokens')
  if (!state.stats) await refreshStats()
}

function renderShell() {
  const titles = {
    overview: ['概览', '知识库运行状态与最近活动'],
    bases: ['知识库', '创建知识库，并限定项目与会话的召回和写入范围'],
    entries: ['知识', '检索、整理和维护已生效知识'],
    candidates: ['审核', '确认 AI 提取结果后再写入知识库'],
    tokens: ['访问管理', '管理其他客户端连接中央知识库的权限'],
  }
  const [title, subtitle] = titles[state.view]
  const shell = element('div', { class: 'app-shell', 'data-menu-open': String(state.menuOpen) },
    renderSidebar(),
    element('main', { class: 'main' },
      element('header', { class: 'topbar' },
        element('div', { class: 'topbar-title' },
          actionButton('☰', () => { state.menuOpen = !state.menuOpen; renderShell() }, 'ghost mobile-menu', { 'aria-label': '打开导航菜单' }),
          element('div', {}, element('h1', {}, title), element('p', {}, subtitle)),
        ),
        element('div', { class: 'topbar-actions' },
          state.view === 'bases'
            ? actionButton('+ 新建知识库', () => openKnowledgeBaseEditor(), 'primary')
            : state.view === 'entries' || state.view === 'overview'
            ? actionButton('+ 新建知识', () => openEntryEditor(), 'primary')
            : null,
        ),
      ),
      element('div', { class: 'page' }, renderCurrentView()),
    ),
  )
  if (state.menuOpen) shell.addEventListener('click', (event) => {
    if (event.target === shell) { state.menuOpen = false; renderShell() }
  })
  app.replaceChildren(shell)
}

function renderSidebar() {
  const pending = state.stats?.candidates.pending
  const navItems = [
    ['overview', '概览', '◫'], ['bases', '知识库', '▦'], ['entries', '知识', '◇'], ['candidates', '审核', '✓'], ['tokens', '访问管理', '⌁'],
  ]
  return element('aside', { class: 'sidebar', 'aria-label': '知识库导航' },
    element('div', { class: 'brand' },
      element('div', { class: 'brand-mark', 'aria-hidden': 'true' }, 'K'),
      element('div', {}, element('strong', {}, 'DSH Knowledge'), element('span', {}, '管理控制台')),
    ),
    element('nav', { class: 'nav' }, navItems.map(([id, label, icon]) => element('button', {
      type: 'button', class: 'nav-button', 'aria-current': state.view === id ? 'page' : undefined,
      onClick: () => navigate(id),
    }, element('span', { class: 'nav-icon', 'aria-hidden': 'true' }, icon), label,
    id === 'candidates' && pending ? element('span', { class: 'nav-count', 'aria-label': `${pending} 条待审核` }, pending) : null))),
    element('div', { class: 'sidebar-footer' },
      element('div', { class: 'connection' }, element('span', { class: 'status-dot', 'aria-hidden': 'true' }), '知识库已连接'),
      actionButton('退出当前会话', signOut, 'ghost small'),
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
  return element('div', { class: 'loading', role: 'status' }, element('div', {}, element('div', { class: 'spinner', 'aria-hidden': 'true' }), element('span', { class: 'visually-hidden' }, '正在加载')))
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
  return element('div', { class: 'bases-page' },
    element('section', { 'aria-labelledby': 'bases-heading' },
      element('div', { class: 'section-heading' },
        element('div', {}, element('h2', { id: 'bases-heading' }, `知识库 · ${activeBases.length}`), element('p', {}, '每个知识库拥有独立的默认标签和提取规则。')),
        actionButton('+ 创建知识库', () => openKnowledgeBaseEditor(), 'primary'),
      ),
      activeBases.length
        ? element('div', { class: 'base-grid' }, activeBases.map(renderKnowledgeBaseCard))
        : emptyState('还没有可用知识库', '先创建一个知识库，再挂载到项目或会话。', '创建知识库', () => openKnowledgeBaseEditor()),
      archivedBases.length ? element('details', { class: 'archived-bases' },
        element('summary', {}, `已归档知识库 · ${archivedBases.length}`),
        element('div', { class: 'base-grid' }, archivedBases.map(renderKnowledgeBaseCard)),
      ) : null,
    ),
    element('section', { class: 'mount-section', 'aria-labelledby': 'mounts-heading' },
      element('div', { class: 'section-heading' }, element('div', {},
        element('h2', { id: 'mounts-heading' }, '当前项目与会话挂载'),
        element('p', {}, '会话默认继承项目设置；创建会话覆盖后，可独立调整或关闭。'),
      )),
      contextAvailable
        ? element('div', { class: 'mount-context' },
          state.mountContext.projectId ? contextPill('项目', state.mountContext.projectId) : contextPill('项目', '当前页面未提供'),
          state.mountContext.sessionId ? contextPill('会话', state.mountContext.sessionId) : contextPill('会话', '当前页面未提供'),
        )
        : element('div', { class: 'context-warning' }, '请从 DSH 当前会话的左侧“知识库”入口打开，才能管理当前项目和会话的挂载。'),
      contextAvailable && activeBases.length
        ? element('div', { class: 'mount-list' }, activeBases.map(renderMountCard))
        : null,
    ),
  )
}

function contextPill(label, value) {
  return element('div', { class: 'context-pill' }, element('strong', {}, label), element('span', { title: value }, value))
}

function renderKnowledgeBaseCard(base) {
  const archived = base.status === 'archived'
  return element('article', { class: `base-card${archived ? ' is-archived' : ''}` },
    element('div', { class: 'base-card-header' },
      element('div', {}, element('h3', {}, base.name), element('small', {}, base.id === 'default' ? '系统默认库' : `ID · ${base.id}`)),
      badge(archived ? '已归档' : '可用', archived ? '' : 'success'),
    ),
    element('div', { class: 'base-description' }, element('strong', {}, '回写匹配描述'), element('p', {}, base.description || '未设置：按通用知识库处理')),
    base.defaultTags.length
      ? element('div', { class: 'tag-row' }, base.defaultTags.map(tag => element('span', { class: 'tag' }, `#${tag}`)))
      : element('span', { class: 'field-hint' }, '无默认标签'),
    base.extractionInstructions
      ? element('div', { class: 'base-instructions' }, element('strong', {}, '提取要求'), element('span', {}, base.extractionInstructions))
      : null,
    element('div', { class: 'base-card-actions' },
      actionButton('查看知识', () => {
        state.entryFilters.knowledgeBaseId = base.id
        void navigate('entries')
      }, 'ghost small'),
      archived ? actionButton('恢复', () => confirmRestoreKnowledgeBase(base), 'primary small') : actionButton('编辑', () => openKnowledgeBaseEditor(base), 'small'),
      !archived && base.id !== 'default' ? actionButton('归档', () => confirmArchiveKnowledgeBase(base), 'danger small') : null,
    ),
  )
}

function renderMountCard(base) {
  return element('article', { class: 'mount-card' },
    element('div', { class: 'mount-card-title' }, element('div', {}, element('h3', {}, base.name), element('small', {}, base.description || '独立知识范围'))),
    state.mountContext.projectId ? renderMountRow(base, 'project', state.mountContext.projectId) : null,
    state.mountContext.sessionId ? renderMountRow(base, 'session', state.mountContext.sessionId) : null,
  )
}

function findExplicitMount(baseId, targetKind, targetId) {
  return state.mounts.find(mount => mount.knowledgeBaseId === baseId && mount.targetKind === targetKind && mount.targetId === targetId)
}

function renderMountRow(base, targetKind, targetId) {
  const explicit = findExplicitMount(base.id, targetKind, targetId)
  const inherited = targetKind === 'session' && !explicit && state.mountContext.projectId
    ? findExplicitMount(base.id, 'project', state.mountContext.projectId)
    : undefined
  const source = explicit || (inherited?.enabled ? inherited : undefined)
  let status
  let detail
  if (explicit && !explicit.enabled) {
    status = badge('已关闭', 'danger')
    detail = '显式禁用，不会继承项目设置'
  } else if (source) {
    status = badge(explicit ? '已挂载' : '继承项目', explicit ? 'success' : 'accent')
    detail = `${source.recallEnabled ? '召回开启' : '召回关闭'} · ${WRITE_MODE_LABELS[source.writeMode]}`
  } else {
    status = badge('未挂载')
    detail = '不召回、不提取、不回写'
  }
  return element('div', { class: 'mount-row' },
    element('div', { class: 'mount-row-label' }, element('strong', {}, targetKind === 'project' ? '项目' : '会话'), status),
    element('div', { class: 'mount-row-detail' }, detail,
      source?.includeTags.length ? element('span', {}, ` · 包含 #${source.includeTags.join(' #')}`) : null,
      source?.excludeTags.length ? element('span', {}, ` · 排除 #${source.excludeTags.join(' #')}`) : null,
    ),
    actionButton(explicit ? '设置' : inherited?.enabled ? '覆盖' : '挂载', () => openMountEditor(base, targetKind, targetId, explicit, inherited), 'small'),
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
      element('div', {}, element('h2', { id: 'candidates-heading' }, 'AI 提取候选'), element('p', {}, '候选内容由模型生成，通过人工确认后才参与后续召回。')),
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
      element('div', { class: 'candidate-reason' }, element('strong', {}, '模型判断依据'), candidate.reason || '未提供判断说明'),
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
  return element('section', { 'aria-labelledby': 'tokens-heading' },
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
    revoked ? null : actionButton('撤销', () => confirmRevokeToken(token), 'danger small'),
  )
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
  for (const field of [name, description, tags, instructions]) field.wrapper.classList.add('span-2')
  form.append(name.wrapper, description.wrapper, tags.wrapper, instructions.wrapper)
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

function openMountEditor(base, targetKind, targetId, explicit, inherited) {
  const source = explicit || inherited || {
    enabled: true, recallEnabled: true, writeMode: 'audit', includeTags: [], excludeTags: [], extractionInstructions: '',
  }
  const enabled = element('input', { type: 'checkbox', checked: source.enabled })
  const recall = element('input', { type: 'checkbox', checked: source.recallEnabled })
  const writeMode = selectField('写入方式', [
    { value: 'none', label: '仅召回（不提取、不回写）' },
    { value: 'audit', label: '审核写入（先进待审核）' },
    { value: 'direct', label: '直接写入（低置信度或冲突仍待审）' },
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

function openEntryEditor(entry, candidate) {
  const source = candidate?.draft || entry || {
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
