import { createRoot } from 'react-dom/client'
import { Workspace } from './ui/Workspace.jsx'

/** Mount into Knowledge's document, preserving its navigation and theme. */
export function mount(element) {
  const style = document.createElement('link')
  style.rel = 'stylesheet'; style.href = '/worklog-assets/workspace.css'
  let disposed = false
  const root = createRoot(element)
  style.onload = () => { if (!disposed) root.render(<Workspace embedded currentProject={new URLSearchParams(location.search).get('projectId') || ''} openSession={window.parent !== window ? sessionId => {
    const origin = document.referrer ? new URL(document.referrer).origin : location.origin
    window.parent.postMessage({ type: '@lemoncat7/dsh-worklog/open-session', sessionId }, origin === 'null' ? '*' : origin)
  } : undefined} />) }
  style.onerror = () => { if (!disposed) element.textContent = '工作日报样式加载失败，请切换工作区后重试。' }
  document.head.append(style)
  return () => { disposed = true; root.unmount(); style.remove() }
}

