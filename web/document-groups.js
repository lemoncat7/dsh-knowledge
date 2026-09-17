/** Document classification controls. No document content or path mutations. */
export function createDocumentGroupField({ element, api, baseId, value = '', required = false, onChange = () => {} }) {
  const id = `document-group-${crypto.randomUUID()}`
  const newValue = `new-${crypto.randomUUID()}`
  const status = element('small', { class: 'muted', role: 'status' }, '正在读取已有分组…')
  const select = element('select', { id, class: 'select', 'aria-label': '文档分组' }, element('option', { value: '' }, '选择已有分组'))
  const input = element('input', { type: 'text', class: 'input', maxlength: 64, value, placeholder: '例如：部署运维、项目约定', 'aria-label': '新分组名称' })
  input.hidden = true
  let groups = [], current = value
  const notify = () => {
    current = select.value === newValue ? input.value.trim() : select.value
    status.textContent = '优先选择已有分组；没有合适的再新建。'
    status.setAttribute('role', 'status')
    wrapper.querySelectorAll('[aria-invalid]').forEach(control => control.removeAttribute('aria-invalid'))
    onChange(current)
  }
  select.addEventListener('change', () => { input.hidden = select.value !== newValue; notify(); if (!input.hidden) input.focus() })
  input.addEventListener('input', notify)
  const wrapper = element('div', { class: 'document-group-field' }, element('label', { for: id }, `文档分组${required ? ' *' : ''}`), select, input, status)
  const ready = api(`document-groups?${new URLSearchParams({ knowledgeBaseId: baseId })}`).then(result => {
    groups = result.filter(item => item.name)
    select.replaceChildren(element('option', { value: '' }, required ? '请选择分组' : '未分组'),
      ...groups.map(item => element('option', { value: item.name }, `${item.name}（${item.count}）`)), element('option', { value: newValue }, '+ 新建分组…'))
    const matched = groups.find(item => item.name.normalize('NFKC').toLocaleLowerCase() === value.normalize('NFKC').trim().toLocaleLowerCase())
    select.value = matched?.name || (value ? newValue : '')
    if (matched) current = matched.name
    input.hidden = select.value !== newValue
    status.textContent = '优先选择已有分组；没有合适的再新建。'
    return groups
  }).catch(error => {
    status.textContent = `读取分组失败：${error.message}。请重新打开后重试。`
    select.disabled = true
    throw error
  })
  // Callers may await ready before saving. Avoid unhandled rejections in inline editors.
  void ready.catch(() => {})
  const validate = () => {
    const name = current.normalize('NFKC').trim().replace(/\s+/gu, ' ')
    const error = required && (!name || name === '未分组') ? '请选择已有分组，或填写新分组名称。'
      : name.length > 64 || /[\u0000-\u001f\u007f]/u.test(current) ? '分组限 64 字，不能包含控制字符。' : ''
    if (error) {
      status.textContent = error; status.setAttribute('role', 'alert')
      const control = input.hidden ? wrapper.querySelector('[role="combobox"]') || select : input
      control.setAttribute('aria-invalid', 'true'); control.focus()
      throw new Error(error)
    }
    return name
  }
  return { wrapper, ready, value: () => current, validate }
}

export function renderDocumentGroups({ element, documents, baseId, collapsed, searching, renderRow, onDrop, onNew }) {
  const groups = new Map()
  for (const doc of documents) { const name = doc.group || ''; if (!groups.has(name)) groups.set(name, []); groups.get(name).push(doc) }
  return [...groups].sort(([a], [b]) => !a ? 1 : !b ? -1 : a.localeCompare(b, 'zh-CN')).map(([name, members]) => {
    const key = JSON.stringify([baseId, name])
    let expanded = searching || !collapsed.has(key)
    const body = element('div', { class: 'document-group-body', role: 'group', 'aria-label': `${name || '未分组'}文档` })
    const toggle = element('button', { type: 'button', class: 'document-group-toggle', 'aria-expanded': String(expanded), onClick: () => {
      expanded = !expanded; if (expanded) collapsed.delete(key); else collapsed.add(key); paint()
    } }, element('span', { class: 'tree-disclosure', 'aria-hidden': 'true' }), element('span', { class: 'tree-folder-icon', 'aria-hidden': 'true' }),
    element('span', { class: 'document-group-name', title: name || '未分组' }, name || '未分组'), element('small', { title: '当前已加载的文档数' }, members.length))
    const paint = () => { toggle.setAttribute('aria-expanded', String(expanded)); body.hidden = !expanded; body.replaceChildren(...(expanded ? members.map(renderRow) : [])) }
    paint()
    return element('section', { class: 'document-tree-group', 'data-document-group': name, onDragOver: event => {
      if (!onDrop || !event.dataTransfer.types.includes('application/x-dsh-knowledge-document-id')) return
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'
    }, onDrop: event => { if (onDrop) { event.stopPropagation(); onDrop(event, name) } } },
    element('div', { class: 'document-group-heading' }, toggle, name && onNew ? element('button', { type: 'button', class: 'button ghost small document-group-add', 'aria-label': `在${name}新建文档`, title: '在此分组新建文档', onClick: () => onNew(name) }, '+') : null), body)
  })
}

export async function openDocumentGroupOrganizer({ element, api, openSheet, baseId, onApply }) {
  const field = createDocumentGroupField({ element, api, baseId })
  const selected = new Set()
  let loaded = false
  const status = element('small', { class: 'muted', role: 'status' }, '正在读取文档…')
  const list = element('div', { class: 'document-group-selection' })
  const controller = new AbortController()
  const body = element('div', { class: 'document-group-field' }, field.wrapper, status, list)
  const dialog = openSheet({ title: '整理文档分组', description: '选择文档并调整分组。选择“未分组”只移除归类，不会删除文档。', body, primaryLabel: '应用分组',
    onClose: () => controller.abort(),
    onPrimary: async () => { await field.ready; if (!loaded) throw new Error('请等待文档加载完成；加载失败请重新打开。'); if (!selected.size) throw new Error('请至少选择一篇文档。'); await onApply([...selected], field.validate()); return true },
  })
  try {
    let cursor, count = 0
    do {
      const page = await api(`document-index?${new URLSearchParams({ knowledgeBaseId: baseId, limit: '100', ...(cursor ? { cursor } : {}) })}`, { signal: controller.signal })
      for (const doc of page.items) {
        const check = element('input', { type: 'checkbox', 'aria-label': doc.title, onChange: event => { if (event.target.checked) selected.add(doc.id); else selected.delete(doc.id) } })
        list.append(element('label', { class: 'document-group-choice' }, check, element('span', {}, element('strong', { title: doc.title }, doc.title), element('small', {}, doc.group || '未分组'))))
      }
      count += page.items.length; cursor = page.nextCursor
      status.textContent = `已加载 ${count} / ${page.total} 篇；每次最多整理 500 篇。`
    } while (cursor && count < 500)
    loaded = true
  } catch (error) { if (!controller.signal.aborted) status.textContent = `读取失败：${error.message}` }
  return dialog
}
