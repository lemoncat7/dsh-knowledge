/** Selection is captured before opening the dialog; no editor ownership here. */
import { createDocumentGroupField } from './document-groups.js'
export async function openNoteExcerpt({ node, text, api, element, openSheet, showToast, friendlyError, formField, selectField, knowledgeBasePathLabel }) {
  if (!text.trim() || text.length > 50000) throw new Error('每次请选择 1 到 50000 字的笔记内容。')
  const bases = (await api('knowledge-bases')).filter(base => base.status === 'active')
  if (!bases.length) throw new Error('请先创建一个可用的知识库。')
  const base = selectField('目标知识库', bases.map(item => ({ value: item.id, label: knowledgeBasePathLabel(item) })), bases[0].id)
  const mode = selectField('添加方式', [{ value: 'existing', label: '追加到已有知识文档' }, { value: 'new', label: '新建知识文档' }], 'existing')
  const title = formField('新文档标题', 'text', node.name.replace(/\.md$/i, ''), { maxlength: 200 })
  const search = formField('搜索知识文档', 'search', '', { placeholder: '输入关键词，或输入 / 浏览全部文档' })
  for (const [key, field] of Object.entries({ base, mode, title, search })) {
    field.input.id = `excerpt-${key}-${crypto.randomUUID()}`
    field.wrapper.querySelector('label').htmlFor = field.input.id
    field.wrapper.classList.add('span-2')
  }
  title.wrapper.hidden = true
  const groupSlot = element('div', { class: 'span-2', hidden: true })
  let groupField
  const loadGroup = () => {
    groupField = createDocumentGroupField({ element, api, baseId: base.input.value, required: true, onChange: () => { requestId = crypto.randomUUID(); sync() } })
    groupSlot.replaceChildren(groupField.wrapper)
  }
  const results = element('div', { class: 'note-picker-results span-2', 'aria-live': 'polite' })
  const status = element('p', { class: 'muted span-2', role: 'status' }, '请选择目标文档')
  const fields = element('fieldset', { class: 'form-grid note-excerpt-fields' }, base.wrapper, mode.wrapper, title.wrapper, groupSlot, search.wrapper, results, status)
  // Only bound the visual preview; submission always retains the entire selection.
  const preview = text.length > 1200 ? `${text.slice(0, 1200)}\n…（预览已省略，完整选文仍会添加）` : text
  const form = element('form', {}, fields, element('blockquote', { class: 'note-excerpt-preview' }, preview))
  form.addEventListener('submit', event => event.preventDefault())
  let selected, requestId = crypto.randomUUID(), sequence = 0, timer, closed = false, pending = false
  const controller = new AbortController()
  const modal = openSheet({
    title: '摘录到知识库', description: '追加选中文字并链接到原笔记，同时建立笔记引用。原笔记保留，不自动同步正文。',
    body: form, primaryLabel: '添加摘录',
    onClose: () => { closed = true; clearTimeout(timer); controller.abort() },
    onPrimary: async () => {
      if (mode.input.value === 'existing' && !selected) throw new Error('请先选择一个可编辑的知识文档。')
      if (mode.input.value === 'new' && !title.input.value.trim()) throw new Error('请填写新文档标题。')
      if (mode.input.value === 'new') { await groupField?.ready; groupField?.validate(); if (!groupField?.value() || groupField.value() === '未分组') throw new Error('请为新文档选择分组。') }
      pending = true
      fields.disabled = true
      try {
        const entry = await api('note-excerpts', { method: 'POST', body: {
          requestId, noteId: node.id, text, knowledgeBaseId: base.input.value,
          ...(mode.input.value === 'existing' ? { documentId: selected.id, expectedVersion: selected.version } : { title: title.input.value.trim(), group: groupField.value() }),
        } })
        showToast(`已添加到「${entry.title}」，并关联来源笔记。`)
        return true
      } catch (error) {
        if (error.status === 409) { selected = undefined; status.textContent = '文档发生变化，请重新选择目标后再添加。'; requestId = crypto.randomUUID() }
        throw error
      } finally { pending = false; fields.disabled = false }
    },
  })
  const primary = modal.dialog.querySelector('.dialog-footer button:last-child')
  function sync() { primary.disabled = pending || (mode.input.value === 'existing' ? !selected : !title.input.value.trim()) }
  async function load(cursor) {
    const current = ++sequence
    if (closed || mode.input.value !== 'existing') return
    const query = search.input.value.trim()
    if (!query) {
      selected = undefined; results.replaceChildren(); results.hidden = true
      status.textContent = '输入关键词搜索，输入 / 按目录顺序浏览全部文档。'
      sync(); return
    }
    results.hidden = false
    if (!cursor) { selected = undefined; results.replaceChildren(); status.textContent = '正在读取文档…'; sync() }
    try {
      const params = new URLSearchParams({ knowledgeBaseId: base.input.value, q: query === '/' ? '' : query, active: '1', limit: '50', ...(cursor ? { cursor } : {}) })
      const page = await api(`document-index?${params}`, { signal: controller.signal })
      if (closed || current !== sequence) return
      results.querySelector('[data-load-more]')?.remove()
      for (const doc of page.items) {
        const button = element('button', { type: 'button', class: 'note-picker-row note-excerpt-document-row', title: doc.title, 'aria-label': doc.title, disabled: doc.documentState !== 'open', 'aria-pressed': 'false' },
          element('span', {}, element('strong', {}, doc.title), element('small', { title: doc.relPath || '' }, `${doc.relPath || '根目录'}${doc.documentState === 'open' ? '' : ' · 已定稿，不能追加'}`)))
        button.addEventListener('click', async () => {
          if (pending) return
          const choice = ++sequence
          selected = undefined; sync(); status.textContent = '正在读取目标版本…'
          try {
            const entry = await api(`entries/${encodeURIComponent(doc.id)}`, { signal: controller.signal })
            if (closed || choice !== sequence) return
            if (entry.status !== 'active' || entry.documentState !== 'open' || entry.knowledgeBaseId !== base.input.value) throw new Error('文档已移动或不可编辑，请重新搜索。')
            selected = entry; requestId = crypto.randomUUID()
            results.querySelectorAll('button[aria-pressed]').forEach(item => item.setAttribute('aria-pressed', String(item === button)))
            status.textContent = `将追加到：${entry.title}`; sync()
          } catch (error) { if (!closed && choice === sequence) status.textContent = friendlyError(error) }
        })
        results.append(button)
      }
      if (page.nextCursor) {
        const more = element('button', { type: 'button', class: 'note-picker-row note-excerpt-document-row', 'data-load-more': '' }, '加载更多')
        more.addEventListener('click', () => { more.disabled = true; void load(page.nextCursor) })
        results.append(more)
      }
      status.textContent = results.children.length ? '请选择目标文档，或切换为新建知识文档。' : '没有匹配的文档，可以新建。'
    } catch (error) {
      if (!closed && current === sequence) {
        status.textContent = friendlyError(error)
        const more = results.querySelector('[data-load-more]')
        if (more) more.disabled = false
        else {
          const retry = element('button', { type: 'button', class: 'note-picker-row note-excerpt-document-row' }, '重新加载文档')
          retry.addEventListener('click', () => { void load() })
          results.replaceChildren(retry)
        }
      }
    }
  }
  base.input.addEventListener('change', () => { requestId = crypto.randomUUID(); if (mode.input.value === 'existing') void load(); else { loadGroup(); sync() } })
  mode.input.addEventListener('change', () => {
    clearTimeout(timer); sequence++; requestId = crypto.randomUUID(); selected = undefined
    const creating = mode.input.value === 'new'
    groupSlot.hidden = !creating
    if (creating) loadGroup()
    title.wrapper.hidden = !creating; search.wrapper.hidden = creating; results.hidden = creating
    status.textContent = creating ? '将新建文档并自动引用来源笔记。' : '请选择目标文档'
    sync(); if (!creating) void load()
  })
  title.input.addEventListener('input', () => { requestId = crypto.randomUUID(); sync() })
  search.input.addEventListener('input', () => {
    clearTimeout(timer); sequence++; selected = undefined; results.replaceChildren(); results.hidden = true; sync()
    if (!search.input.value.trim()) { void load(); return }
    status.textContent = '正在搜索文档…'
    timer = setTimeout(() => void load(), 200)
  })
  sync(); void load()
}
