// Source-change overview: the host runs the periodic comparison, so this view only shows the last result.
const CHANGE_EXAMPLES = 3

/**
 * Scanning, the source-change overview and the processing guard.
 *
 * Owns the model/python controls, the scan preview, the change panel and the "another library is
 * busy" guard. The job card list and the running-job bar come from the jobs block; requests,
 * state and the busy wrapper come from the workspace context.
 */
export function createScanBlock(context) {
  const { element, actionButton, badge, state, url, call, run } = context
  // Scope remains a backend compatibility policy, not a manual setup task.
  const pythonSelect = element('select', { class: 'select', 'aria-label': 'Python 解释器' })
  const pythonNote = element('p', { class: 'wiki-hint' })
  const providerSelect = element('select', { class: 'select', 'aria-label': '模型 provider' })
  const modelSelect = element('select', { class: 'select', 'aria-label': '模型' })
  const consentToggle = element('input', { type: 'checkbox' })
  const previewNote = element('p', { class: 'wiki-hint' })
  const previewList = element('div', { class: 'wiki-list' })
  let processButton
  let processBlockedNote
  let previewCount = 0
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
    context.activity.textContent = '正在检查目录与已有页面，只读取，不移动文件…'
    const result = await call(url('scan'), { method: 'POST', body: {} })
    context.renderConnection(result.connection)
    const total = renderScanPreview(result.files, result.folders, result.skipped)
    const totals = { ...total, skipped: result.files.length - total.fresh.length }
    previewNote.textContent = total.fresh.length
      ? scanSummary(totals)
      : total.blocked
        ? `没有待处理原件（跳过 ${totals.skipped} 个已处理）；另有 ${total.blocked} 个文件因过大未处理（见下方说明）。根层文件与根层文件夹都会扫描，已归档的分类目录不重复处理。`
        : `没有待处理原件（跳过 ${totals.skipped} 个已处理）。根层文件与根层文件夹都会扫描，已归档的分类目录不重复处理。`
    previewCount = total.fresh.length
    processButton.hidden = !total.fresh.length
    applyProcessingGuard()
    await context.loadJobs()
    return total.fresh.length ? `发现 ${total.fresh.length} 个原件，等待你确认处理` : '没有待处理原件'
  }

  /** The host allows one running job across all libraries, so an idle library can still be blocked. */
  async function findElsewhereRunning() {
    for (const base of context.bases) {
      if (base.id === context.kbId) continue
      try {
        const jobs = await call(`wiki/${encodeURIComponent(base.id)}/jobs`)
        const running = (jobs ?? []).find(job => job.state === 'running')
        if (running) return { kbId: base.id, name: base.name, jobId: running.id,
          message: `另一个知识库正在处理，请先在那边完成或停止（${base.name} · 任务 ${String(running.id).slice(0, 8)}）` }
      } catch { /* a library we cannot read never blocks this one */ }
    }
  }

  async function refreshElsewhere() {
    const local = state.jobs.some(job => job.state === 'running')
    state.blocked = local ? undefined : await findElsewhereRunning()
    applyProcessingGuard()
  }

  /** Keep the processing button honest: no preview, no consent or another busy library all disable it. */
  function applyProcessingGuard() {
    const blocked = state.blocked
    if (processBlockedNote) {
      processBlockedNote.hidden = !blocked
      processBlockedNote.textContent = blocked ? `${blocked.message}；那边完成后点「刷新任务」即可继续。` : ''
    }
    if (processButton) processButton.disabled = !previewCount || !consentToggle.checked || Boolean(blocked)
  }

  /** The library switch keeps the current consent choice out of the next library. */
  function resetConsent() { consentToggle.checked = false }

  const dailySection = element('section', { class: 'wiki-section' },
    element('h2', {}, '扫描更新'),
    element('p', { class: 'wiki-section-note' }, '根层文件与根层新增文件夹里的资料都会扫描；已归档的分类目录不重复处理。模型只返回结构化候选，由宿主写入文件。'),
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
        context.activity.textContent = '正在启动处理任务…'
        let job
        try {
          job = await call(url('process'), { method: 'POST', body: {
            python: pythonSelect.value, provider: providerSelect.value, model: modelSelect.value, allowModel: true,
          } })
        } catch (error) {
          const failure = context.jobFailure(error)
          if (failure.code === 'WIKI_JOB_RUNNING_ELSEWHERE') { state.blocked = context.elsewhereInfo(error); applyProcessingGuard() }
          throw new Error(failure.message)
        }
        await context.loadJobs()
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
      actionButton('刷新任务', () => void run(async () => { await context.loadJobs(); return '任务状态已刷新' }), 'ghost small'),
      context.jobs.dismissFinishedButton),
    context.jobs.runBar, context.activity,
    processBlockedNote = element('p', { class: 'wiki-hint wiki-process-blocked', role: 'status', hidden: true }),
    previewNote, previewList, context.jobs.jobList)

  consentToggle.addEventListener('change', applyProcessingGuard)

  return { changeSection, dailySection, loadPython, loadModels, loadChanges, startScan, applyProcessingGuard, refreshElsewhere, resetConsent }
}
