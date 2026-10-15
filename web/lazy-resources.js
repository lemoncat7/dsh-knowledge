/** Deduplicate feature loads; a failed download remains retryable. */
export function createLazyResources({ moduleUrl, scriptUrl, document = globalThis.document, global = globalThis, importModule = url => import(url) }) {
  const modules = new Map()
  const scripts = new Map()
  function module(name) {
    if (!modules.has(name)) modules.set(name, Promise.resolve().then(() => importModule(moduleUrl(name))).catch(error => {
      modules.delete(name)
      throw error
    }))
    return modules.get(name)
  }
  function script(name, exportName) {
    if (global[exportName]) return Promise.resolve(global[exportName])
    if (!scripts.has(name)) {
      const pending = new Promise((resolve, reject) => {
        const node = document.createElement('script')
        node.src = scriptUrl(name)
        node.async = true
        node.onload = () => {
          if (global[exportName]) resolve(global[exportName])
          else { node.remove(); reject(new Error('页面组件加载失败，请重试。')) }
        }
        node.onerror = () => { node.remove(); reject(new Error('页面组件下载失败，请检查连接后重试。')) }
        document.head.append(node)
      }).catch(error => { scripts.delete(name); throw error })
      scripts.set(name, pending)
    }
    return scripts.get(name)
  }
  return { module, script }
}
