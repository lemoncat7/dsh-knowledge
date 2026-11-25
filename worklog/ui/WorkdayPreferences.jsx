import { Select } from './Select.jsx'
import { useEffect, useId, useState } from 'react'
import { DialogActions } from './Dialog.jsx'

const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

export function WorkdayPreferences({ value, busy, action, onDirty }) {
  const formId = useId()
  const [draft, setDraft] = useState(value)
  const [day, setDay] = useState(''), [workday, setWorkday] = useState(false), [message, setMessage] = useState('')
  const dirty = JSON.stringify(draft) !== JSON.stringify(value)
  useEffect(() => { onDirty(dirty); return () => onDirty(false) }, [dirty, onDirty])
  useEffect(() => { if (!dirty) setDraft(value) }, [value.revision])
  const change = patch => { setDraft(current => ({ ...current, ...patch })); setMessage('') }
  const toggle = number => change({ weekdays: draft.weekdays.includes(number) ? draft.weekdays.filter(item => item !== number) : [...draft.weekdays, number].sort((a, b) => a - b) })
  async function submit(event) {
    event.preventDefault()
    const result = await action('/calendar-workdays-settings', draft)
    if (result?.workdays) { setDraft(result.workdays); setMessage('工作日设置已保存，后续结转将使用新规则。') }
  }
  return <form id={formId} className="wc-workday-settings" onSubmit={submit}>
    <fieldset disabled={busy}>
      <legend>工作日</legend>
      <p className="wl-muted">选择每周工作日。目标设为「下一个工作日」后，未完成的事项会跳过休息日。</p>
      <div className="wc-workday-presets"><button type="button" onClick={() => change({ weekdays: [1, 2, 3, 4, 5] })}>周一至周五</button><button type="button" onClick={() => change({ weekdays: [1, 2, 3, 4, 5, 6, 7] })}>每天</button></div>
      <div className="wc-workday-week" role="group" aria-label="每周工作日">{weekdays.map((label, index) => <label key={label} className="wl-check"><input type="checkbox" checked={draft.weekdays.includes(index + 1)} onChange={() => toggle(index + 1)} />{label}</label>)}</div>
      {!draft.weekdays.length && <p className="wl-error">请至少选择一个工作日。</p>}
      <h3>自定义工作日</h3>
      <p className="wl-muted">为调休或假期指定例外日期；指定日期优先于每周规则。</p>
      <div className="wc-workday-date"><label>指定日期<input type="date" min="1900-01-01" max="2200-12-31" value={day} onChange={event => setDay(event.target.value)} /></label><label>这一天是<Select value={String(workday)} onChange={event => setWorkday(event.target.value === 'true')}><option value="true">工作日</option><option value="false">休息日</option></Select></label><button type="button" disabled={!day || draft.overrides.length >= 366 && !draft.overrides.some(item => item.day === day)} onClick={() => { change({ overrides: [...draft.overrides.filter(item => item.day !== day), { day, workday }].sort((a, b) => a.day.localeCompare(b.day)) }); setDay('') }}>设置</button></div>
      <ul className="wc-workday-overrides">{draft.overrides.map(item => <li key={item.day}><time>{item.day}</time><span>{item.workday ? '工作日' : '休息日'}</span><button type="button" aria-label={`移除 ${item.day} 的例外`} onClick={() => change({ overrides: draft.overrides.filter(row => row.day !== item.day) })}>移除</button></li>)}</ul>
      {dirty && draft.revision !== value.revision && <p className="wl-error">设置已在其他位置更新。<button type="button" onClick={() => setDraft(value)}>重新载入设置</button></p>}
    </fieldset>
    {message && <p className="wl-muted" role="status">{message}</p>}
    <DialogActions><button type="submit" form={formId} className="wl-primary" disabled={busy || !dirty || !draft.weekdays.length || draft.revision !== value.revision}>{busy ? '保存中…' : '保存工作日'}</button></DialogActions>
  </form>
}
