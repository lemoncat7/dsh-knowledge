const STATUS_LABEL = { running: '运行中', paused: '已暂停', done: '已完成', cancelled: '已取消' }
const STAGE_LABEL = { new: '待归类', classified: '已归类', archived: '已归档', extracted: '待蒸馏', done: '已完成', review: '待人工确认', failed: '失败' }

/**
 * Job list and job actions.
 *
 * Owns the running-job bar, the card list, progress polling and the dismiss/cancel/resume
 * handlers. The shared state, request wrapper and lifecycle come from the workspace context;
 * cross-block work (processing guard, read-only page view, page index) is reached through it.
 */
export function createJobsBlock(context) {
  const { element, actionButton, badge, state, url, call, run } = context
  let progressTimer
  let progressWasRunning = false
  let progressFailures = 0
  const jobList = element('div', { class: 'wiki-list' })
  const runBar = element('div', { class: 'wiki-runbar', hidden: true })
  const runText = element('span', {}, '')
  const stopButton = actionButton('停止', () => void run(async () => {
    if (!state.runningJobId) return '当前没有正在运行的任务'
    return cancelJob(state.runningJobId)
  }), 'danger small')
  runBar.append(runText, stopButton)
  const dismissFinishedButton = actionButton('清除已结束任务', () => void run(dismissFinishedJobs), 'ghost small', { hidden: true })

  function stageSummary(job) {
    const total = job.items.length
    const done = job.items.filter(item => item.stage === 'done').length
    const failed = job.items.filter(item => item.stage === 'failed').length
    const review = job.items.filter(item => item.stage === 'review').length
    const current = job.state === 'running' ? job.items.find(item => !['done', 'review'].includes(item.stage)) : undefined
    const parts = [`完成 ${done}/${total}`]
    if (failed) parts.push(`失败 ${failed}`)
    if (review) parts.push(`待人工 ${review}`)
    if (current) parts.push(`当前：${current.source.split(/[\\/]/).pop()}（${current.activity || stageLabelOf(current)}）`)
    return parts.join(' · ')
  }

  /** Error text carries a stable code plus whatever prose the host attached. */
  const errorText = error => String(error?.code ?? '') + ' ' + String(error?.message ?? '')
  /** Only one library may process at a time, so a refusal names the library that holds the slot. */
  function elsewhereInfo(error) {
    const match = /库\s*(\S+)\s*的任务\s*(\S+)\s*正在处理/.exec(String(error?.message ?? ''))
    const kbId = match?.[1] ?? '', jobId = match?.[2] ?? ''
    const name = kbId ? (context.bases.find(base => base.id === kbId)?.name ?? kbId) : ''
    return { kbId, jobId, name,
      message: `另一个知识库正在处理，请先在那边完成或停止${name ? `（${name}${jobId ? ` · 任务 ${jobId.slice(0, 8)}` : ''}）` : ''}` }
  }
  /** Stable code plus the Chinese sentence the operator should read; raw codes never reach the screen. */
  function jobFailure(error) {
    const reason = errorText(error)
    const code = ['WIKI_JOB_RUNNING_ELSEWHERE', 'WIKI_JOB_NOT_FOUND', 'WIKI_JOB_RUNNING', 'WIKI_JOB_CANCELLED']
      .find(value => reason.includes(value)) ?? ''
    const message = code === 'WIKI_JOB_RUNNING_ELSEWHERE' ? elsewhereInfo(error).message
      : code === 'WIKI_JOB_NOT_FOUND' ? '任务记录已不存在，请刷新任务列表'
        : code === 'WIKI_JOB_RUNNING' ? '任务仍在运行，请先停止再移除'
          : code === 'WIKI_JOB_CANCELLED' ? '任务已取消，不能续跑；请重新扫描' : String(error?.message ?? error)
    return { code, message }
  }
  /** One place for job actions: a vanished record refreshes the list, a refusal explains itself. */
  async function jobAction(jobId, body) {
    try {
      return await call(url(`job/${jobId}`), { method: 'POST', body })
    } catch (error) {
      const failure = jobFailure(error)
      if (failure.code === 'WIKI_JOB_NOT_FOUND') await loadJobs()
      if (failure.code === 'WIKI_JOB_RUNNING_ELSEWHERE') { state.blocked = elsewhereInfo(error); context.applyProcessingGuard() }
      throw Object.assign(new Error(failure.message), { jobCode: failure.code })
    }
  }

  /** The host hides cancelled jobs; keep the card so the outcome and the remove action stay visible. */
  async function cancelJob(jobId) {
    await jobAction(jobId, { action: 'cancel' })
    const job = state.jobs.find(entry => entry.id === jobId)
    if (job) {
      job.state = 'cancelled'
      job.items = (job.items ?? []).map(item => ({ ...item, activity: undefined }))
    }
    drawJobs(state.jobs)
    scheduleProgress(state.jobs)
    context.activity.textContent = '任务已取消，可点移除清理'
    return '任务已取消，可点移除清理'
  }

  async function resumeJob(jobId) {
    try {
      await jobAction(jobId, { action: 'resume' })
    } catch (error) {
      // A stale card pointed at a job the host already cancelled: close it instead of retrying.
      if (error.jobCode === 'WIKI_JOB_CANCELLED') {
        const job = state.jobs.find(entry => entry.id === jobId)
        if (job) { job.state = 'cancelled'; drawJobs(state.jobs) }
      }
      throw error
    }
    await loadJobs()
    return '任务已续跑'
  }

  async function dismissJob(jobId) {
    await jobAction(jobId, { action: 'dismiss' })
    // Drop the card locally: the list must not reload the whole page for one hidden record.
    state.jobs = state.jobs.filter(entry => entry.id !== jobId)
    drawJobs(state.jobs)
    return '已移除该任务记录；已处理的文件不受影响'
  }

  async function dismissFinishedJobs() {
    const result = await call(url('job'), { method: 'POST', body: { action: 'dismiss-finished' } })
    const hidden = Number(result?.hidden ?? 0)
    state.jobs = state.jobs.filter(entry => !['done', 'cancelled'].includes(entry.state))
    drawJobs(state.jobs)
    return hidden ? `已清除 ${hidden} 条已结束任务记录` : '没有可清除的已结束任务'
  }

  /**
   * A standalone delivery is never archived, so its stage label must not say "已归档" anywhere —
   * neither on the item badge nor in the running summary.
   */
  function stageLabelOf(item) {
    return item.standalone === true && item.stage === 'archived' ? '原件原位' : (STAGE_LABEL[item.stage] ?? item.stage)
  }
  function standaloneNote(item) {
    if (item.stage !== 'done') return '原位提取（不归档）'
    return item.pages?.length ? '已生成知识页（原件未移动）' : '原位提取（不归档），未生成知识页'
  }

  function drawJobs(jobs) {
    // Local list: cancel/dismiss update the card in place instead of reloading the whole page.
    state.jobs = jobs
    const active = jobs.find(job => job.state === 'running')
    state.runningJobId = active?.id ?? ''
    runBar.hidden = !active
    if (active) runText.textContent = `处理中：${stageSummary(active)}`
    if (dismissFinishedButton) dismissFinishedButton.hidden = !jobs.some(job => job.state === 'done' || job.state === 'cancelled')
    jobList.replaceChildren()
    if (!jobs.length) { jobList.append(element('p', { class: 'muted' }, '还没有入库任务。')); return }
    for (const job of jobs) {
      // Running jobs are stopped from the sticky bar only; finished ones can be removed; a cancelled
      // job can never be resumed, so it offers removal instead.
      const actions = job.state === 'running' ? []
        : job.state === 'cancelled' ? [actionButton('移除', () => void run(() => dismissJob(job.id)), 'ghost small')]
          : job.state === 'done' ? [
            actionButton('续跑', () => void run(() => resumeJob(job.id)), 'ghost small'),
            actionButton('移除', () => void run(() => dismissJob(job.id)), 'ghost small')]
            : [actionButton('续跑', () => void run(() => resumeJob(job.id)), 'ghost small'),
              actionButton('取消', () => void run(() => cancelJob(job.id)), 'ghost small')]
      const head = element('div', { class: 'wiki-row' },
        element('strong', {}, `任务 ${job.id.slice(0, 8)}`),
        badge(STATUS_LABEL[job.state] ?? job.state, job.state === 'done' ? 'success' : job.state === 'paused' ? 'warning' : job.state === 'cancelled' ? 'danger' : ''),
        element('span', { class: 'muted' }, job.discovery ? `发现 ${job.discovery.found} 个，跳过 ${job.discovery.duplicates} 个已处理` : ''),
        actionButton('刷新', () => void run(loadJobs), 'ghost small'),
        ...actions)
      const progress = element('p', { class: job.state === 'running' ? 'wiki-progress is-running' : 'wiki-progress', 'aria-live': 'polite' }, stageSummary(job))
      const detail = element('div', { class: 'wiki-job-items' })
      for (const item of job.items) {
        // A refused external-edit conflict must never read as if the page had been written.
        const conflict = /WIKI_EXTERNAL_EDIT_CONFLICT/.test(item.error ?? '')
        const row = element('div', { class: 'wiki-row wiki-row-detail' },
          element('span', { class: 'wiki-path', title: item.source }, item.source.split(/[\\/]/).pop()),
          badge(stageLabelOf(item), item.stage === 'failed' ? 'danger' : item.stage === 'review' ? 'warning' : item.stage === 'done' ? 'success' : ''),
          item.error
            ? element('small', { class: conflict ? 'wiki-hint' : 'wiki-error', ...(conflict ? { title: item.error } : {}) },
              conflict ? '该页已被外部修改，未覆盖；请刷新索引后重试' : item.error)
            : null)
        if (item.stage === 'review') {
          row.append(actionButton('指定分类', () => void run(async () => {
            const category = window.prompt('输入分类文件夹名')
            if (!category) return
            await call(url(`job/${job.id}`), { method: 'POST', body: { action: 'classify', itemId: item.id, category } })
            await loadJobs()
          }), 'ghost small'))
        }
        if (item.standalone === true) row.append(element('small', { class: 'wiki-hint' }, standaloneNote(item)))
        else if (item.stage === 'done' && item.registered) row.append(element('small', { class: 'wiki-hint' }, '已登记（原位，不搬运）：该类型不抽取、不生成知识页'))
        else if (item.stage === 'done' && !item.pages?.length && !item.updatedPages?.length) row.append(element('small', { class: 'wiki-hint' }, '已记录处理结果，未生成知识页'))
        // `pages` lists every page the item touched; `updatedPages` is the subset that replaced an
        // existing page. Only the rest are new, otherwise an update is counted twice and gets two buttons.
        const touched = item.pages ?? [], updated = item.updatedPages ?? []
        const created = touched.filter(path => !updated.includes(path))
        if (created.length) row.append(element('small', { class: 'wiki-hint' }, `新增 ${created.length} 篇页面`))
        if (updated.length) row.append(element('small', { class: 'wiki-hint' }, `更新 ${updated.length} 篇页面`))
        for (const path of updated) row.append(actionButton('已更新：' + path, () => void run(() => context.openResultPage(path)), 'ghost small'))
        for (const path of created) row.append(actionButton('查看关联页：' + path, () => void run(() => context.openResultPage(path)), 'ghost small'))
        detail.append(row)
      }
      jobList.append(element('div', { class: 'wiki-card' }, head, progress, detail))
    }
  }

  async function loadJobs(options = {}) {
    const jobs = await call(url('jobs'))
    drawJobs(jobs)
    await context.refreshElsewhere()
    if (!options.quiet) scheduleProgress(jobs)
    return null
  }

  /** While a job runs, refresh the card so stage changes are visible without clicking. */
  function scheduleProgress(jobs) {
    window.clearTimeout(progressTimer)
    const token = context.currentGeneration()
    const running = jobs.some(job => job.state === 'running')
    if (context.isDisposed() || !running || !context.root.isConnected) { if (!running) progressWasRunning = false; return }
    progressWasRunning = true
    progressTimer = window.setTimeout(async () => {
      if (context.isDisposed() || token !== context.currentGeneration() || !context.root.isConnected) return
      try {
        const next = await call(url('jobs'))
        progressFailures = 0
        drawJobs(next)
        const stillRunning = next.some(job => job.state === 'running')
        if (!stillRunning && progressWasRunning) { progressWasRunning = false; void context.loadPages().catch(() => {}) }
        scheduleProgress(next)
      } catch (error) {
        if (context.isDisposed() || token !== context.currentGeneration()) return
        progressFailures++
        context.status.textContent = `进度获取失败（${progressFailures}/3）：${error.message}；${progressFailures >= 3 ? '自动刷新已停止，请手动刷新任务' : '稍后重试'}`
        if (progressFailures < 3) scheduleProgress([{ state: 'running' }])
      }
    }, 2000 * Math.max(1, 2 ** progressFailures))
  }

  /** Used by the library switch and dispose: stop the polling timer without touching its state. */
  function stopPolling() { window.clearTimeout(progressTimer) }

  return { jobList, runBar, dismissFinishedButton, loadJobs, drawJobs, scheduleProgress, cancelJob, resumeJob, dismissJob, dismissFinishedJobs, jobFailure, elsewhereInfo, stopPolling }
}
