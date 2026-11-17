/** Lazy workspace extension: no extra Host sidebar item, iframe, or polling. */
export function createWorklogWorkspace({ element, actionButton, view = 'worklog' }) {
  const title = view === 'calendar' ? '工作日历' : '工作日报'
  const root = element('section', { class: 'knowledge-worklog', 'data-ui-owned': 'react', 'aria-label': title + '工作区' })
  let disposed = false, unmount
  async function load() {
    root.replaceChildren(element('p', { role: 'status' }, `正在打开${title}…`))
    try {
      const module = await import('/worklog-assets/workspace.js')
      if (!disposed) unmount = module.mount(root, { view })
    } catch {
      if (!disposed) root.replaceChildren(element('div', { class: 'empty-state', role: 'alert' },
        element('h2', {}, '工作记录暂不可用'),
        element('p', {}, '知识库工作记录模块加载失败，请刷新后重试。原有知识文档不受影响。'),
        actionButton('重新加载', load)))
    }
  }
  void load()
  return { root, dispose() { disposed = true; unmount?.() } }
}
