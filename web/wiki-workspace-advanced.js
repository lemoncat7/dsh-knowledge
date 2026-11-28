const RAW_PAGE = 100

/**
 * Read-only page inspection and the advanced maintenance panel.
 *
 * Owns the page list, the raw viewer, the manual editor and the diagnostics actions
 * (inspect / rebuild / recover). A job's produced page is opened here read-only; the editor
 * buffer is only reachable from this panel.
 */
export function createAdvancedBlock(context) {
  const { element, actionButton, badge, state, url, call, run } = context
  const pageList = element('div', { class: 'wiki-list' })
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

  editor.addEventListener('input', () => { state.dirty = true; saveButton.disabled = false })
  rawDetails.addEventListener('toggle', () => { if (rawDetails.open && !rawLoaded) void run(loadRaw) })
  rawFilter.addEventListener('input', () => { if (rawLoaded) renderRaw() })
  advancedDetails.addEventListener('toggle', () => {
    if (!advancedDetails.open || pagesLoaded) return
    pagesLoaded = true
    void run(loadPages)
  })

  async function resetPages() {
    pagesLoaded = false
    pageList.replaceChildren()
    if (!advancedDetails.open) return
    pagesLoaded = true
    await loadPages()
  }

  async function loadPages() {
    pageList.replaceChildren()
    if (!state.configs.some(entry => entry.kbId === context.kbId)) {
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

  /** Read-only view of a page a job produced or refreshed; it never opens the editor buffer. */
  async function openResultPage(path) {
    const pages = await call(url('pages'))
    const page = pages.find(entry => entry.relPath === path)
    if (!page) throw new Error('关联页面未登记，请刷新索引后再试')
    const value = await call(url(`page/${encodeURIComponent(page.pageId)}`))
    context.openModal({ title: '只读查看 · ' + path, body: element('pre', { class: 'wiki-pre' }, value.content), cancelLabel: '关闭' })
    return '已打开只读内容'
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

  advancedDetails.append(element('div', { class: 'wiki-actions' },
    actionButton('只读检查', () => void run(async () => {
      const items = await call(url('inspect'))
      context.connectionView.replaceChildren(...items.map(item => element('p', { class: 'wiki-hint' }, item.relPath + ' · ' + (item.error || item.status))))
      return '检查完成；未修改文件'
    }), 'ghost small'),
    actionButton('重建索引', () => void run(async () => { await call(url('rebuild'), { method: 'POST', body: {} }); return '索引已重建' }), 'ghost small'),
    actionButton('恢复中断提交', () => void run(async () => { await call(url('recover'), { method: 'POST', body: {} }); await context.reload(); return '恢复检查完成' }), 'ghost small')))

  /** The library switch drops the editor binding without touching the saved page. */
  function clearEditorBinding() {
    editor.value = ''; editorTitle.textContent = '未选择文件'; saveButton.disabled = true
    rawView.textContent = ''; rawView.hidden = true
  }

  return { details: advancedDetails, pageList, rawList, loadPages, resetPages, loadRaw, resetRaw, openResultPage, clearEditorBinding }
}
