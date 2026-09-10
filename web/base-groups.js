/** Display-only grouping. Knowledge contents, mounts and recall are untouched. */
const nameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
export const knowledgeBasePathLabel = base => `${base.group || '未分组'} / ${base.name}`
export function sortKnowledgeBasesByGroup(bases) {
  return [...bases].sort((a, b) => {
    const left = a.group || '', right = b.group || ''
    if (Boolean(left) !== Boolean(right)) return left ? -1 : 1
    return nameCollator.compare(left, right) || nameCollator.compare(a.name, b.name) || String(a.id).localeCompare(String(b.id))
  })
}

export function groupKnowledgeBases(bases) {
  const groups = new Map()
  for (const base of bases) {
    const name = base.group || ''
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(base)
  }
  return [...groups].sort(([a], [b]) => !a ? 1 : !b ? -1 : a.localeCompare(b, 'zh-CN'))
}

export function createBaseGroups({ element, actionButton, interfaceIcon, openSheet, formField, api, getBases, refresh, showToast, storageKey }) {
  let collapsed = new Set()
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '[]')
    if (Array.isArray(saved)) collapsed = new Set(saved.filter(value => typeof value === 'string'))
  } catch {}
  const remember = () => { try { localStorage.setItem(storageKey, JSON.stringify([...collapsed])) } catch {} }

  function render(bases, renderCard, searching = false, scope = 'active') {
    return element('div', { class: 'base-groups' }, groupKnowledgeBases(bases).map(([name, members]) => {
      const key = JSON.stringify([scope, name])
      let expanded = searching || !collapsed.has(key)
      const body = element('div', { class: 'base-grid base-group-body', id: `base-group-${scope}-${encodeURIComponent(name)}` })
      const toggle = element('button', {
        type: 'button', class: 'base-group-toggle', 'aria-expanded': String(expanded), 'aria-controls': body.id,
        onClick: () => {
          expanded = !expanded
          if (expanded) collapsed.delete(key); else collapsed.add(key)
          remember(); update()
        },
      }, interfaceIcon('chevron-right', 'base-group-chevron'),
      element('span', { class: 'base-group-name', title: name || '未分组' }, name || '未分组'),
      element('span', { class: 'summary-count' }, members.length))
      const update = () => {
        toggle.setAttribute('aria-expanded', String(expanded))
        body.hidden = !expanded
        // Closed groups do not mount card DOM or animation observers.
        body.replaceChildren(...(expanded ? members.map(renderCard) : []))
      }
      update()
      return element('section', { class: 'base-group', 'aria-label': name || '未分组' },
        element('div', { class: 'base-group-heading' }, toggle,
          name ? actionButton('重命名', () => edit(name), 'ghost small', { 'aria-label': `重命名分组 ${name}` }) : null), body)
    }))
  }

  function edit(current) {
    const renaming = typeof current === 'string'
    const bases = getBases()
    const name = formField('分组名称', 'input', current || '', { id: 'knowledge-group-name', required: true, maxlength: 64, placeholder: '例如：家里助手、工作、个人' })
    name.wrapper.querySelector('label').htmlFor = name.input.id
    const selection = new Map()
    const error = element('p', { role: 'alert', class: 'base-group-error' })
    const form = element('form', { class: 'base-group-form', onSubmit: event => event.preventDefault() }, name.wrapper)
    if (!renaming) {
      form.append(element('p', {}, '选择要归入这个分组的知识库；原有内容和挂载保持不变。'))
      form.append(element('div', { class: 'base-group-picker' }, bases.map(base => {
        const checkbox = element('input', { type: 'checkbox', value: base.id })
        selection.set(base.id, checkbox)
        return element('label', { class: 'check-option' }, checkbox,
          element('span', {}, element('strong', {}, base.name), element('small', {}, `${base.group || '未分组'}${base.status === 'archived' ? ' · 已归档' : ''}`)))
      })))
    }
    form.append(error)
    openSheet({
      title: renaming ? '重命名分组' : '新建分组',
      description: '每个知识库属于一个分组；没有知识库的分组自动消失。',
      body: form, primaryLabel: renaming ? '保存分组' : '创建分组',
      onPrimary: async () => {
        name.input.setCustomValidity(name.input.value.trim() ? '' : '请输入分组名称')
        if (!form.reportValidity()) return false
        const ids = renaming ? bases.filter(base => base.group === current).map(base => base.id)
          : [...selection].filter(([, input]) => input.checked).map(([id]) => id)
        error.textContent = ''
        if (!ids.length) { error.textContent = '请至少选择一个知识库'; return false }
        await api('knowledge-bases/group', { method: 'POST', body: { ids, group: name.input.value.trim() } })
        collapsed.delete(JSON.stringify(['active', name.input.value.trim()]))
        remember()
        await refresh()
        showToast(renaming ? '分组已更新；同名分组会合并显示。' : '知识库已分组。')
        return true
      },
    })
    name.input.addEventListener('input', () => name.input.setCustomValidity(''))
    name.input.focus()
  }
  return { render, edit }
}
