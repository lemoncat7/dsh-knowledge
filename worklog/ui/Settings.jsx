import { useState } from 'react'
import { ModelPicker } from './ModelPicker.jsx'

export function Settings({ state, save, busy, currentProject = '' }) {
  const [config, set] = useState(state.config)
  const [project, setProject] = useState('')
  const projects = [...new Set([currentProject, ...state.projects, ...config.projects].filter(Boolean))]
  return <form onSubmit={e => { e.preventDefault(); save(config) }}>
    <p>只采集开启之后、所选项目中的新对话。不依赖知识库挂载，不自动发送渠道消息。</p>
    <label className="wl-check"><input type="checkbox" checked={config.enabled} onChange={e => set({ ...config, enabled: e.target.checked })} />启用工作素材采集</label>
    <h3>采集项目</h3>
    <div className="wl-actions" role="group" aria-label="采集范围">
      <button type="button" aria-pressed={config.scope === 'all'} onClick={() => set({ ...config, scope: 'all' })}>全部项目</button>
      <button type="button" aria-pressed={config.scope !== 'all'} onClick={() => set({ ...config, scope: 'selected' })}>选择项目</button>
    </div>
    {config.scope === 'all' ? <p className="wl-muted">包含当前及未来项目的新对话，仍排除下方指定的会话。保存并开启采集后生效。</p> : <>
    <p className="wl-muted">从当前及已记录的项目选择，也可手写路径；不选项目则不采集。</p>
    {currentProject && <button type="button" onClick={() => set({ ...config, projects: [...new Set([...config.projects, currentProject])] })}>添加当前项目</button>}
    <div className="wl-projects">
    {projects.map(id => <label className="wl-check" key={id}><input type="checkbox" checked={config.projects.includes(id)} onChange={e => set({ ...config, projects: e.target.checked ? [...config.projects, id] : config.projects.filter(p => p !== id) })} /><span title={id}>{id}</span></label>)}
    </div>
    <label>添加项目路径<input value={project} onChange={e => setProject(e.target.value)} placeholder="例如 /workspace/my-project" /></label>
    <button type="button" disabled={!project.trim()} onClick={() => { set({ ...config, projects: [...new Set([...config.projects, project.trim()])] }); setProject('') }}>添加项目</button>
    </>}
    <label>日期时区<input value={config.timezone} onChange={e => set({ ...config, timezone: e.target.value })} placeholder="Asia/Shanghai" /></label>
    <p className="wl-muted">更改时区只影响后续记录，不移动历史日报。</p>
    <label>排除会话（每行一个会话 ID）<textarea rows={3} value={config.excludedSessions.join('\n')} onChange={e => set({ ...config, excludedSessions: e.target.value.split('\n').filter(Boolean) })} /></label>
    <ModelPicker provider={config.provider} model={config.model} onChange={(provider, model) => set({ ...config, provider, model })} />
    <footer><button disabled={busy} className="wl-primary">{busy ? '保存中…' : '保存设置'}</button></footer>
  </form>
}

