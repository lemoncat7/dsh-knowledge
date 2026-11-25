import { useEffect, useRef, useState } from 'react'
import { Select } from './Select.jsx'

const directions = { both: '双向', push: '仅上传', pull: '仅下载', off: '暂停' }
const comparable = rows => JSON.stringify(rows.map(({ groupId, calendar, direction }) => ({ groupId, calendar, direction })).sort((a, b) => a.calendar.localeCompare(b.calendar)))
export function ICloudMappings({ icloud, groups, groupsRevision, busy, action, dirtyChanged }) {
  const [calendars, setCalendars] = useState(null), [draft, setDraft] = useState(icloud.mappings ?? []), [revision, setRevision] = useState(icloud.revision)
  const [message, setMessage] = useState(''), [reading, setReading] = useState(false)
  const autoGroups = useRef(new Map()), latestAction = useRef(action), mounted = useRef(true)
  latestAction.current = action
  const dirty = comparable(draft) !== comparable(icloud.mappings ?? [])
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty
  useEffect(() => { dirtyChanged(dirty); return () => dirtyChanged(false) }, [dirty, dirtyChanged])
  useEffect(() => {
    if (!dirtyRef.current) { setDraft(icloud.mappings ?? []); setRevision(icloud.revision) }
  }, [icloud.revision])
  async function read(refresh = false) {
    setReading(true)
    const result = await latestAction.current('/calendar-icloud-calendars', refresh ? { refresh: true } : {})
    if (mounted.current) { if (result) setCalendars(result.calendars); setReading(false) }
  }
  useEffect(() => { mounted.current = true; void read(); return () => { mounted.current = false } }, [])
  function automatic(calendar) {
    if (!autoGroups.current.has(calendar.id)) {
      const names = new Set([...groups, ...autoGroups.current.values()].map(group => group.name))
      const base = calendar.name.trim().slice(0, 48) || 'iCloud 日历'
      let name = base, index = 1
      while (names.has(name)) name = `${base} (${++index})`
      autoGroups.current.set(calendar.id, { id: crypto.randomUUID(), name, color: ['blue', 'purple', 'green', 'rose'][autoGroups.current.size % 4] })
    }
    return autoGroups.current.get(calendar.id)
  }
  function toggle(calendar, checked) {
    setMessage('')
    setDraft(current => {
      if (!checked) return current.filter(mapping => mapping.calendar !== calendar.id)
      if (current.some(mapping => mapping.calendar === calendar.id)) return current
      const matching = groups.find(group => group.name === calendar.name && !current.some(mapping => mapping.groupId === group.id))
      return [...current, { calendar: calendar.id, groupId: matching?.id ?? automatic(calendar).id, direction: calendar.writable === false ? 'pull' : 'both' }]
    })
  }
  function change(calendar, patch) { setMessage(''); setDraft(current => current.map(mapping => mapping.calendar === calendar ? { ...mapping, ...patch } : mapping)) }
  async function save() {
    const createGroups = [...autoGroups.current.values()].filter(group => !groups.some(item => item.id === group.id) && draft.some(mapping => mapping.groupId === group.id))
    const result = await action('/calendar-icloud-mappings', { revision, mappings: draft.map(({ groupId, calendar, direction }) => ({ groupId, calendar, direction })),
      ...(createGroups.length ? { groupsRevision, createGroups } : {}) })
    if (result?.icloud) { setDraft(result.icloud.mappings); setRevision(result.icloud.revision); setMessage('同步选择已保存。所选日历分别保存在对应分组中。') }
  }
  const missing = icloud.mappings.filter(mapping => calendars && !calendars.some(calendar => calendar.id === mapping.calendar)).map(mapping => ({ id: mapping.calendar, name: mapping.name, missing: true }))
  const rows = [...(calendars ?? []), ...missing]
  return <section className="wc-mappings" aria-label="分组同步关联">
    <div className="wc-mappings-heading"><div><strong>同步 iCloud 日历</strong><span className="wl-muted">{calendars ? `已选 ${draft.length} / ${rows.length} 个` : '正在读取账号目录…'}</span></div>
      <button type="button" disabled={busy || reading || icloud.running} onClick={() => read(true)}>{reading ? '读取中…' : '刷新目录'}</button></div>
    <p className="wl-muted">勾选多个日历分别同步。可选已有本地分组，也可在保存时新建同名分组。</p>
    {!calendars && !reading && <p className="wl-muted">目录读取失败，可点击「刷新目录」重试。</p>}
    {!!rows.length && <div className="wc-cloud-table">
      <div className="wc-cloud-table-head" aria-hidden="true"><span>iCloud 日历</span><span>本地分组</span><span>同步方式</span></div>
      {rows.map(calendar => {
        const mapping = draft.find(item => item.calendar === calendar.id)
        const generated = automatic(calendar)
        return <div className={`wc-cloud-row${mapping ? ' is-selected' : ''}`} key={calendar.id}>
          <label className="wc-cloud-check"><input type="checkbox" aria-label={`同步 ${calendar.name}`} disabled={busy || icloud.running} checked={!!mapping} onChange={event => toggle(calendar, event.target.checked)} /><span><strong>{calendar.name}</strong>{calendar.writable === false && <small>只读</small>}{calendar.missing && <small>目录中已不可用，可取消同步</small>}</span></label>
          <label className="wc-cloud-group"><span className="wc-mobile-field-name">本地分组</span><Select aria-label={`${calendar.name} 的本地分组`} disabled={busy || !mapping} value={mapping?.groupId ?? ''} onChange={event => change(calendar.id, { groupId: event.target.value })}>
            {!mapping && <option value="">未同步</option>}
            {groups.map(group => { const used = draft.some(item => item.calendar !== calendar.id && item.groupId === group.id); return <option key={group.id} value={group.id} disabled={used}>{group.name}{used ? '（已关联）' : ''}</option> })}
            {!groups.some(group => group.id === generated.id) && <option value={generated.id}>新建「{generated.name}」</option>}
          </Select></label>
          <label className="wc-cloud-direction"><span className="wc-mobile-field-name">同步方式</span><Select aria-label={`${calendar.name} 同步方向`} disabled={busy || !mapping} value={mapping?.direction ?? 'both'} onChange={event => change(calendar.id, { direction: event.target.value })}>
            {Object.entries(directions).map(([key, label]) => <option key={key} value={key} disabled={calendar.writable === false && ['both', 'push'].includes(key)}>{label}</option>)}
          </Select></label>
        </div>
      })}
    </div>}
    <div className="wc-local-group-summary"><span>全部本地分组</span><div>{groups.map(group => <span key={group.id}><strong>{group.name}</strong><small>{draft.some(mapping => mapping.groupId === group.id) ? '已关联' : '仅本地'}</small></span>)}</div></div>
    <div className="wc-mapping-save"><span className="wl-muted">取消勾选仅停止关联，保留两端条目。</span><button type="button" className="wl-primary" disabled={busy || !dirty || icloud.running} onClick={save}>保存同步选择</button></div>
    {message && <p role="status" className="wl-muted">{message}</p>}
  </section>
}
