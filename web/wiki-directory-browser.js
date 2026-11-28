/** Shared-modal folder browser. Selection is committed only after a successful listing. */
export function createWikiDirectoryBrowser({ api, endpoint, element: el, actionButton: button, interfaceIcon: icon, openModal, initial = '', label = '目录', onSelect }) {
  let current = '', entries = [], closed = false, generation = 0, controller
  const quick = el('nav', { class: 'wiki-browser-places', 'aria-label': '快捷位置' })
  const path = el('input', { class: 'input', type: 'search', value: initial, 'aria-label': '当前目录路径', placeholder: '输入路径后按 Enter，或从左侧选择位置' })
  const filter = el('input', { class: 'input', type: 'search', 'aria-label': '筛选文件夹', placeholder: '筛选当前目录中的文件夹' })
  const count = el('span', { class: 'wiki-browser-count' })
  const listing = el('div', { class: 'wiki-browser-list', 'aria-label': '文件夹列表' })
  const message = el('p', { class: 'wiki-browser-message', role: 'status', 'aria-live': 'polite' })
  const selected = el('code', { class: 'wiki-browser-selection' }, '尚未选择目录')
  const parent = button(icon('chevron-right'), () => void load(parent.dataset.path), 'ghost small wiki-browser-up', { 'aria-label': '上一级目录', disabled: true })
  const jump = button('前往', () => void load(path.value.trim()), 'ghost small')
  const location = el('div', { class: 'wiki-browser-location' }, parent, path, jump)
  const body = el('div', { class: 'wiki-browser' },
    el('aside', { class: 'wiki-browser-sidebar' }, el('strong', {}, '快捷位置'), quick),
    el('section', { class: 'wiki-browser-main' }, location,
      el('div', { class: 'wiki-browser-filter' }, filter, count), message, listing),
    el('div', { class: 'wiki-browser-selected' }, el('span', {}, '当前选择'), selected))
  const dialog = openModal({ title: `选择${label}`, description: '打开文件夹后，点击「使用此目录」确认。不会修改或创建任何文件。',
    className: 'wiki-browser-dialog', body, cancelLabel: '取消', primaryLabel: '使用此目录',
    onPrimary: () => {
      if (!current || body.getAttribute('aria-busy') === 'true') throw new Error('请等待目录读取完成后再确认')
      onSelect(current)
      return true
    },
    onClose: () => { closed = true; generation++; controller?.abort() },
  })
  const primary = dialog.dialog.querySelector('.dialog-footer .button:last-child')
  if (primary) primary.disabled = true

  function render() {
    const query = filter.value.trim().toLocaleLowerCase()
    const shown = entries.filter(item => item.name.toLocaleLowerCase().includes(query))
    count.textContent = query ? `${shown.length} / ${entries.length} 个文件夹` : `${entries.length} 个文件夹`
    listing.replaceChildren(...(shown.length ? shown.map(item => button([
      el('span', { class: 'wiki-folder-mark', 'aria-hidden': 'true' }),
      el('span', { class: 'wiki-browser-name' }, item.name), icon('chevron-right'),
    ], () => void load(item.path), 'ghost wiki-browser-entry', { title: item.path, 'aria-label': `打开文件夹 ${item.name}` }))
      : [el('p', { class: 'wiki-browser-empty' }, query ? '没有匹配的文件夹' : '此目录没有子文件夹，可直接使用当前目录')]))
  }
  async function load(requested) {
    const token = ++generation
    controller?.abort(); controller = new AbortController()
    body.setAttribute('aria-busy', 'true')
    parent.disabled = true
    if (primary) primary.disabled = true
    message.textContent = '正在读取目录…'; message.classList.remove('is-error')
    listing.replaceChildren(el('p', { class: 'wiki-browser-empty' }, '正在加载文件夹…'))
    try {
      const data = await api(`${endpoint}?${new URLSearchParams(requested ? { path: requested } : {})}`, { signal: controller.signal })
      if (closed || token !== generation) return
      current = data.path; path.value = current; selected.textContent = current; selected.title = current
      entries = data.entries; filter.value = ''
      parent.dataset.path = data.parent ?? ''; parent.disabled = !data.parent
      quick.replaceChildren(...data.shortcuts.map(item => button(item.name, () => void load(item.path), 'ghost small', { title: item.path })))
      message.textContent = data.truncated ? '当前目录项目较多，仅显示前 500 个。可输入子目录路径继续。' : ''
      render()
    } catch (error) {
      if (closed || token !== generation || controller.signal.aborted) return
      current = ''; selected.textContent = '目录读取失败，请重新选择'
      message.classList.add('is-error'); message.textContent = error.message
      listing.replaceChildren(button('重新读取', () => void load(requested), 'ghost small'))
    } finally {
      if (!closed && token === generation) {
        body.removeAttribute('aria-busy')
        if (primary) primary.disabled = !current
      }
    }
  }
  filter.addEventListener('input', render)
  path.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void load(path.value.trim()) } })
  void load(initial || undefined)
  return { ...dialog, load }
}
