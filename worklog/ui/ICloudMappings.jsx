import { useEffect, useRef, useState } from 'react'

const directions = { both: '双向同步', push: '仅上传到 iCloud', pull: '仅从 iCloud 下载', off: '暂停此分组' }
export function ICloudMappings({ icloud, groups, busy, action, dirtyChanged }) {
  const [calendars, setCalendars] = useState(null), [draft, setDraft] = useState(icloud.mappings ?? []), [revision, setRevision] = useState(icloud.revision)
  const [message, setMessage] = useState('')
  const dirty = JSON.stringify(draft) !== JSON.stringify(icloud.mappings ?? [])
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty
  useEffect(() => { dirtyChanged(dirty); return () => dirtyChanged(false) }, [dirty, dirtyChanged])
  useEffect(() => {
    if (!dirtyRef.current) { setDraft(icloud.mappings ?? []); setRevision(icloud.revision) }
  }, [icloud.revision])
  function change(groupId, patch) {
    setMessage('')
    setDraft(current => {
      const old = current.find(mapping => mapping.groupId === groupId)
      const value = { ...old, groupId, ...patch }
      if (!value.calendar) return current.filter(mapping => mapping.groupId !== groupId)
      return old ? current.map(mapping => mapping.groupId === groupId ? value : mapping) : [...current, { ...value, direction: value.direction ?? 'both' }]
    })
  }
  async function save() {
    const result = await action('/calendar-icloud-mappings', { revision, mappings: draft.map(({ groupId, calendar, direction }) => ({ groupId, calendar, direction })) })
    if (result?.icloud) { setDraft(result.icloud.mappings); setRevision(result.icloud.revision); setMessage('分组关联已保存。同步将按所选方向执行。') }
  }
  return <section className="wc-mappings" aria-label="分组同步关联">
    <div className="wc-mappings-heading"><strong>分组同步</strong><button type="button" disabled={busy || icloud.running} onClick={async () => {
      const result = await action('/calendar-icloud-calendars', {})
      if (result) setCalendars(result.calendars)
    }}>{calendars ? '重新读取账号日历' : '读取已登录账号的日历'}</button></div>
    <p className="wl-muted">每个本地分组可关联一个账号日历。未关联的分组只保存在 DSH；暂停会保留两端已有条目。</p>
    {!calendars && icloud.mappings?.map(mapping => <p key={mapping.groupId} className="wl-muted">{groups.find(group => group.id === mapping.groupId)?.name ?? '工作'} → {mapping.name} · {directions[mapping.direction]}</p>)}
    {calendars && <>
      {groups.filter(group => draft.some(mapping => mapping.groupId === group.id)).map(group => {
        const mapping = draft.find(item => item.groupId === group.id)
        return <div className="wc-mapping-row" key={group.id}><label>{group.name}<select aria-label={`${group.name} 同步至`} disabled={busy} value={mapping?.calendar ?? ''} onChange={e => change(group.id, { calendar: e.target.value })}>
          <option value="">仅保存在 DSH</option>{calendars.map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.name}{calendar.writable === false ? '（只读）' : ''}</option>)}
        </select></label><label>同步方向<select aria-label={`${group.name} 同步方向`} value={mapping?.direction ?? 'both'} disabled={busy || !mapping} onChange={e => change(group.id, { direction: e.target.value })}>
          {Object.entries(directions).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label><button type="button" disabled={busy} aria-label={`解除 ${group.name} 的同步关联`} onClick={() => setDraft(current => current.filter(item => item.groupId !== group.id))}>解除关联</button></div>
      })}
      {groups.some(group => !draft.some(mapping => mapping.groupId === group.id)) && <label className="wc-add-mapping">添加同步分组<select aria-label="添加同步分组" value="" disabled={busy} onChange={e => {
        const groupId = e.target.value
        if (groupId) setDraft(current => [...current, { groupId, calendar: '', direction: 'both' }])
      }}><option value="">选择要关联的本地分组</option>{groups.filter(group => !draft.some(mapping => mapping.groupId === group.id)).map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>}
      <p className="wl-muted">双向同步会传播正常编辑和删除；同一条目两端分别修改时才需处理冲突。目标进度、标签和完成状态保存在 DSH。</p>
      <button type="button" className="wl-primary" disabled={busy || !dirty || icloud.running || draft.some(mapping => !mapping.calendar)} onClick={save}>保存同步关联</button>
    </>}
    {message && <p role="status" className="wl-muted">{message}</p>}
  </section>
}
