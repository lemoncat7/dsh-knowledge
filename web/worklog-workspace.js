/** Lazy workspace extension: no extra Host sidebar item, iframe, or polling. */
export function createWorklogWorkspace({ element, actionButton }) {
  const root = element('section', { class: 'knowledge-worklog', 'data-ui-owned': 'react', 'aria-label': '工作日报工作区' })
  let disposed = false, unmount
  async function load() {
    root.replaceChildren(element('p', { role: 'status' }, '正在打开工作日报…'))
    try {
      const module = await import('/worklog-assets/workspace.js')
      if (!disposed) unmount = module.mount(root)
    } catch {
      if (!disposed) root.replaceChildren(element('div', { class: 'empty-state', role: 'alert' },
        element('h2', {}, '工作记录暂不可用'),
        element('p', {}, '请确认当前 DSH 已安装并启用工作记录服务。原有知识文档不受影响。'),
        actionButton('重新加载', load)))
    }
  }
  void load()
  return { root, dispose() { disposed = true; unmount?.() } }
}
