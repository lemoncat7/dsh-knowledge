import { createConnectionBlock } from "./wiki-workspace-connection.js"
import { createScanBlock } from "./wiki-workspace-scan.js"
import { createJobsBlock } from "./wiki-workspace-jobs.js"
import { createAdvancedBlock } from "./wiki-workspace-advanced.js"

/**
 * Wiki workspace for the management console.
 * Uses the shared layout, controls and dialog primitives; the operator never has to
 * paste a path, a Python executable or a model id by hand.
 *
 * The workspace only assembles the blocks and owns the shared state, the request wrapper and
 * the lifecycle; every block receives the same explicit context object.
 */
export function createWikiWorkspace({ api, element, actionButton, badge, interfaceIcon, openModal, bases }) {
  const root = element('section', { class: 'wiki-workspace' })
  const state = { kbId: '', configs: [], pages: [], page: undefined, standard: undefined, dirty: false, runningJobId: '', jobs: [], blocked: undefined }
  const status = element('p', { class: 'wiki-status', role: 'status', 'aria-live': 'polite' })
  const activity = element('p', { class: 'wiki-progress', role: 'status', 'aria-live': 'polite' })
  let busy = false
  let disposed = false, generation = 0
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
  const url = suffix => `wiki/${encodeURIComponent(state.kbId)}/${suffix}`

  const context = {
    element, actionButton, badge, interfaceIcon, openModal, bases,
    root, status, activity, state, url, call, run,
    // Live view of the selected library; blocks never copy it.
    get kbId() { return state.kbId },
    isDisposed: () => disposed,
    currentGeneration: () => generation,
    // Cross-block DOM the connection block toggles and the workspace fills during assembly.
    panels: {},
  }

  async function run(action) {
    if (busy || disposed) return
    busy = true; context.baseSelect.disabled = true; root.setAttribute('aria-busy', 'true'); status.textContent = '处理中…'
    try { status.textContent = (await action()) ?? '已完成' }
    catch (error) { status.textContent = error.message; activity.textContent = error.message }
    finally { busy = false; context.baseSelect.disabled = false; root.removeAttribute('aria-busy') }
  }

  const connection = createConnectionBlock(context)
  context.baseSelect = connection.baseSelect
  context.connectionView = connection.connectionView
  context.renderConnection = connection.renderConnection
  context.refreshConfig = connection.refreshConfig
  context.panels.workspaceInput = connection.workspaceInput

  const jobs = createJobsBlock(context)
  context.jobs = jobs
  context.loadJobs = jobs.loadJobs
  context.jobFailure = jobs.jobFailure
  context.elsewhereInfo = jobs.elsewhereInfo

  const scan = createScanBlock(context)
  context.applyProcessingGuard = scan.applyProcessingGuard
  context.refreshElsewhere = scan.refreshElsewhere
  context.loadPython = scan.loadPython
  context.loadModels = scan.loadModels
  context.loadChanges = scan.loadChanges

  const advanced = createAdvancedBlock(context)
  context.advanced = advanced
  context.openResultPage = advanced.openResultPage
  context.loadPages = advanced.loadPages

  context.panels.settings = connection.settings
  context.panels.daily = scan.dailySection
  context.panels.changes = scan.changeSection

  async function reload() {
    if (!state.kbId) return '请先创建一个空知识库'
    const config = await context.refreshConfig()
    const connectionStatus = await call(url('connection'))
    if (config && connectionStatus.state === 'configured' && config.layout.workspaceRoot.split(/[\\/]/).pop()?.toLowerCase() === 'wiki') context.panels.workspaceInput.value = config.layout.workspaceRoot
    context.renderConnection(connectionStatus)
    if (!config) {
      jobs.jobList.replaceChildren(); advanced.rawList.replaceChildren()
      advanced.pageList.replaceChildren()
      await Promise.all([context.loadPython(), context.loadModels()])
      return '请选择目录并接入知识库'
    }
    await Promise.all([advanced.resetPages(), context.loadJobs(), advanced.resetRaw(), context.loadPython(), context.loadModels(), context.loadChanges({ quiet: true })])
  }
  context.reload = reload

  connection.baseSelect.addEventListener('change', () => {
    const next = connection.baseSelect.value
    if (busy || (state.dirty && !window.confirm('放弃未保存的内容并切换知识库？'))) {
      connection.baseSelect.value = state.kbId
      return
    }
    generation++; jobs.stopPolling()
    for (const controller of requestControllers) controller.abort()
    state.kbId = next
    state.page = undefined; state.standard = undefined; state.dirty = false; state.pages = []
    advanced.clearEditorBinding()
    scan.resetConsent()
    void run(reload)
  })

  root.append(
    connection.section,
    connection.settings,
    scan.changeSection,
    scan.dailySection,
    advanced.details,
    status)

  if (bases.length) { state.kbId = bases[0].id; connection.baseSelect.value = state.kbId }
  else status.textContent = '还没有知识库，请先在「知识库与挂载」中创建一个空知识库。'
  void run(reload)
  return { root, dispose() { disposed = true; generation++; jobs.stopPolling(); for (const controller of requestControllers) controller.abort() } }
}
