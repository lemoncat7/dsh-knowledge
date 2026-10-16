import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DialogActions } from './Dialog.jsx'
import { ModelPicker } from './ModelPicker.jsx'
import { ProjectTree } from './ProjectTree.jsx'
import { HelpTip } from './HelpTip.jsx'
import { buildProjectTree, directoryChain } from '../project-tree.js'

export function Settings({ state, save, saveCapture, busy, currentProject = '', onDirtyChange }) {
  const formId = useId()
  const [config, set] = useState({ ...state.config, sharedRevision: state.sharedRevision })
  const [project, setProject] = useState('')
  const [addedProjects, setAddedProjects] = useState([])
  const initial = useRef(JSON.stringify(config))
  useLayoutEffect(() => { onDirtyChange?.(JSON.stringify(config) !== initial.current || !!project.trim()) }, [config, project, onDirtyChange])
  const projects = useMemo(() => [...new Set([state.defaultProject, currentProject, ...state.projects, ...addedProjects].filter(Boolean))], [state.defaultProject, currentProject, state.projects, addedProjects])
  const known = useMemo(() => buildProjectTree(projects).nodes, [projects])
  const visibleSelected = config.projects.filter(path => known.has(directoryChain(path).at(-1)?.key))
  const otherSelected = config.projects.filter(path => !visibleSelected.includes(path))
  return <form id={formId} onSubmit={e => { e.preventDefault(); save(config) }}>
    <h3 className="wl-setting-heading">本机采集<HelpTip label="本机采集"><span>只采集启用后的用户会话，内部委派子会话不纳入；委派成果通过原会话汇总采集。普通分叉会话正常采集，不补采历史、不自动发送消息。</span><span>本机指运行 DSH 的实例，目录来自本机会话，不扫描磁盘。勾选“包含子目录”后采集全部下级；展开不改变勾选。</span>{state.remote && <span>素材上传中央，断网暂存补传；关闭采集不取消待上传记录、不删除中央记录。</span>}</HelpTip></h3>
    <label className="wl-check"><input type="checkbox" checked={config.enabled} onChange={e => set({ ...config, enabled: e.target.checked })} />启用工作素材采集</label>
    <h3 className="wl-setting-heading wl-setting-subheading">采集工作目录</h3>
    <div className="wl-actions" role="group" aria-label="采集范围">
      <button type="button" aria-pressed={config.scope === 'all'} onClick={() => set({ ...config, scope: 'all' })}>全部目录</button>
      <button type="button" aria-pressed={config.scope !== 'all'} onClick={() => set({ ...config, scope: 'selected' })}>选择目录</button>
    </div>
    {config.scope !== 'all' && <>
    <label className="wl-check"><input type="checkbox" checked={config.recursiveProjects ?? false} onChange={e => set({ ...config, recursiveProjects: e.target.checked })} />包含所选目录的子目录</label>
    <ProjectTree projects={projects} selected={visibleSelected} recursive={config.recursiveProjects ?? false} currentProject={currentProject} defaultProject={state.defaultProject} onSelectCurrent={() => set({ ...config, projects: [...new Set([...config.projects, currentProject])] })} onChange={projects => set({ ...config, projects: [...projects, ...otherSelected] })} />
    {!!otherSelected.length && <details className="wl-saved-paths"><summary>其他已保存目录（{otherSelected.length}）</summary><p className="wl-muted">尚无本机会话依据，可能是手动填写或旧版保存的路径。保留原有配置，不作为本机目录推荐；取消勾选可移除。</p>{otherSelected.map(path => <label className="wl-check" key={path}><input type="checkbox" checked onChange={() => set({ ...config, projects: config.projects.filter(value => value !== path) })} />{path}</label>)}</details>}
    <div className="wl-directory-add"><label>手动添加目录<input value={project} onChange={e => setProject(e.target.value)} placeholder="例如 /workspace/my-project" /></label>
    <button type="button" aria-label="添加并勾选目录" disabled={!project.trim()} onClick={() => { setAddedProjects([...new Set([...addedProjects, project.trim()])]); set({ ...config, projects: [...new Set([...config.projects, project.trim()])] }); setProject('') }}>添加</button></div>
    </>}
    <label>排除会话（每行一个会话 ID）<textarea rows={3} value={config.excludedSessions.join('\n')} onChange={e => set({ ...config, excludedSessions: e.target.value.split('\n').filter(Boolean) })} /></label>
    <h3 className="wl-setting-heading">中央整理<HelpTip label="中央整理"><span>时区、模型和定时任务由中央管理。素材按接收时的时区归档；更改时区不移动已有日报。</span><span>模型来自中央 DSH，不使用上传端模型 ID；只有远端素材或补记时，须指定中央模型。</span><span>超长素材自动分批并保存进度，合并成功后才写入日报。每批最多尝试 3 次，会增加模型调用次数。关闭定时不取消已入队任务。</span></HelpTip></h3>
    {state.remote && !state.canManage && <p className="wl-muted">当前令牌没有管理员权限，中央配置仅可查看；本机采集仍可修改。</p>}
    {state.centralUnavailable ? <p role="status">中央暂不可用，中央配置不能读取或修改；本机采集仍可单独保存。</p> : <fieldset className="wl-central-settings" disabled={state.remote && !state.canManage}>
    <div className="wl-setting-heading"><label htmlFor="wl-timezone">日期时区</label></div>
    <input id="wl-timezone" className="wl-setting-input" value={config.timezone} onChange={e => set({ ...config, timezone: e.target.value })} placeholder="Asia/Shanghai" />
    <ModelPicker central={state.remote} provider={config.provider} model={config.model} onChange={(provider, model) => set({ ...config, provider, model })} />
    <section aria-label="定时整理设置">
      <h3 className="wl-setting-heading wl-setting-subheading">定时整理</h3>
      <label className="wl-check"><input type="checkbox" checked={config.scheduleEnabled ?? false} onChange={e => set({ ...config, scheduleEnabled: e.target.checked })} />每日定时整理</label>
      {config.scheduleEnabled && <>
        <label>每日整理时间<input type="time" required step="60" value={config.scheduleTime ?? '23:00'} onChange={e => set({ ...config, scheduleTime: e.target.value })} /></label>
        <label className="wl-check"><input type="checkbox" checked={config.scheduleCatchup ?? true} onChange={e => set({ ...config, scheduleCatchup: e.target.checked })} />自动补齐未完成日期</label>
        <p className="wl-muted">补齐本次启用定时以来、最近 30 天内未生成日报的日期，每次只补一天。取消的任务、已有日报和手工正文不重跑；临时失败最多额外补偿 2 次，内容或配置未变化的预检失败不循环重试。</p>
      </>}
      {state.scheduleLast && <p className="wl-muted" role="status">最近定时检查 · {state.scheduleLast.day}：{state.scheduleLast.message}{state.scheduleLast.status === 'failed' && ' 请修正设置后，在对应日期点击整理日报重试。'}</p>}
    </section>
    </fieldset>}
    <DialogActions>
      {state.remote && saveCapture && <button type="button" disabled={busy} onClick={() => saveCapture(config)}>仅保存本机采集</button>}
      {!state.centralUnavailable && <button form={formId} type="submit" disabled={busy} className="wl-primary">{busy ? '保存中…' : '保存设置'}</button>}
    </DialogActions>
  </form>
}
