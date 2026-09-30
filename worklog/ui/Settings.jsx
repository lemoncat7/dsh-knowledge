import { useState } from 'react'
import { ModelPicker } from './ModelPicker.jsx'

export function Settings({ state, save, saveCapture, busy, currentProject = '' }) {
  const [config, set] = useState({ ...state.config, sharedRevision: state.sharedRevision })
  const [project, setProject] = useState('')
  const projects = [...new Set([currentProject, ...state.projects, ...config.projects].filter(Boolean))]
  return <form onSubmit={e => { e.preventDefault(); save(config) }}>
    <h3>本机采集</h3>
    <p>{state.remote ? '当前 DSH 实例按本地项目路径采集，并上传至已连接的中央知识库；断网时暂存补传。' : '当前节点保存并整理日报；其他 DSH 实例连接此中央知识库后可上传来源。'}只采集启用后的新对话，不自动发送渠道消息。</p>
    <label className="wl-check"><input type="checkbox" checked={config.enabled} onChange={e => set({ ...config, enabled: e.target.checked })} />启用工作素材采集</label>
    {state.remote && <p className="wl-muted">关闭采集只停止新增素材，不会取消已经授权采集的待上传记录，也不会删除中央记录。</p>}
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
    <label>排除会话（每行一个会话 ID）<textarea rows={3} value={config.excludedSessions.join('\n')} onChange={e => set({ ...config, excludedSessions: e.target.value.split('\n').filter(Boolean) })} /></label>
    {state.remote && saveCapture && <button type="button" disabled={busy} onClick={() => saveCapture(config)}>仅保存本机采集</button>}
    <h3>中央整理</h3>
    <p className="wl-muted">时区、模型与定时任务由中央统一管理。所有连接此中央的实例查看同一份日报；不会在本机额外调用模型整理。</p>
    {state.remote && !state.canManage && <p className="wl-muted">当前令牌没有管理员权限，中央配置仅可查看；本机采集仍可修改。</p>}
    {state.centralUnavailable ? <p role="status">中央暂不可用，中央配置不能读取或修改；本机采集仍可单独保存。</p> : <fieldset className="wl-central-settings" disabled={state.remote && !state.canManage}>
    <label>日期时区<input value={config.timezone} onChange={e => set({ ...config, timezone: e.target.value })} placeholder="Asia/Shanghai" /></label>
    <p className="wl-muted">以中央接收时的时区归档来源；更改时区不移动已有日报。</p>
    <ModelPicker central={state.remote} provider={config.provider} model={config.model} onChange={(provider, model) => set({ ...config, provider, model })} />
    <section aria-label="定时整理设置">
      <h3>定时整理</h3>
      <label className="wl-check"><input type="checkbox" checked={config.scheduleEnabled ?? false} onChange={e => set({ ...config, scheduleEnabled: e.target.checked })} />每日定时整理</label>
      {config.scheduleEnabled && <>
        <label>每日整理时间<input type="time" required step="60" value={config.scheduleTime ?? '23:00'} onChange={e => set({ ...config, scheduleTime: e.target.value })} aria-describedby="wl-schedule-help" /></label>
        <p id="wl-schedule-help" className="wl-muted">按上方时区 {config.timezone}，整理当天截至执行时已有的素材。保存后从下一个设定时间开始；由服务端执行，无需打开页面。会调用所选模型。</p>
        <p className="wl-muted">重启后只补最近一次错过的日期，不批量回填历史。无新素材或正文有手工修改时跳过；当天到点后新增的素材请手动整理。关闭定时不会取消已入队任务。</p>
      </>}
      {state.scheduleLast && <p className="wl-muted" role="status">最近定时检查 · {state.scheduleLast.day}：{state.scheduleLast.message}{state.scheduleLast.status === 'failed' && ' 请修正设置后，在对应日期点击整理日报重试。'}</p>}
    </section>
    </fieldset>}
    {!state.centralUnavailable && <footer><button disabled={busy} className="wl-primary">{busy ? '保存中…' : '保存设置'}</button></footer>}
  </form>
}
