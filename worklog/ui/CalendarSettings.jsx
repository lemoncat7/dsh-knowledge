import { useEffect, useId, useRef, useState } from 'react'
import { api } from './api.js'
import { Dialog } from './Dialog.jsx'
import { localParts, addDays } from '../calendar/time.js'
import { ICloudMappings } from './ICloudMappings.jsx'
import { WorkdayPreferences } from './WorkdayPreferences.jsx'

const issues = {
  conflict: '两端都有改动', 'remote-missing': 'iCloud 已删除，本端另有修改待选择',
  'local-missing': '本端已删除，iCloud 另有修改待选择', unsupported: 'iCloud 条目含周期、邀请或不支持的格式',
  direction: '另一方向的改动未同步，请调整方向或处理原条目',
  stale: 'iCloud 条目刚发生改动，等待重新核对',
}
function summary(value, zone) {
  if (!value) return '无条目'
  if (value.allDay) return `${value.title} · ${value.day} 全天`
  const start = localParts(value.startAt, zone), end = localParts(value.endAt, zone)
  return `${value.title} · ${start.day} ${start.time} 至 ${start.day === end.day ? '' : end.day + ' '}${end.time}`
}
function useCalendarSettings(supported) {
  const [value, setValue] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const [pendingToggle, setPendingToggle] = useState(null)
  useEffect(() => {
    if (!supported || busy) return
    const controller = new AbortController()
    let timer
    async function read() {
      try {
        const result = await api('/calendar-settings', undefined, controller.signal)
        if (!controller.signal.aborted) setValue(result)
      } catch (e) { if (!controller.signal.aborted) setError(e.message) }
      if (!controller.signal.aborted) timer = setTimeout(read, document.hidden ? 30000 : 15000)
    }
    void read()
    return () => { clearTimeout(timer); controller.abort() }
  }, [busy, supported])
  async function action(path, data) {
    if (locked.current) return
    locked.current = true
    setBusy(true); setError('')
    if (path === '/calendar-report-settings' || path === '/calendar-icloud-toggle') setPendingToggle({ path, enabled: data.enabled })
    try {
      const result = await api(path, data)
      if (result.report) setValue(result)
      return result
    } catch (e) { setError(e.message) }
    finally { locked.current = false; setPendingToggle(null); setBusy(false) }
  }
  return { value, error, busy, pendingToggle, action }
}

export function CalendarSettings({ close, supported, today, recheckSupported }) {
  const descriptionId = useId()
  const { value, error, busy, pendingToggle, action } = useCalendarSettings(supported)
  const report = value?.report
  const [dirty, setDirty] = useState(false), [recheckMessage, setRecheckMessage] = useState('')
  return <Dialog title="日历设置" className="wc-report-settings" close={close} busy={busy} protectChanges dirty={dirty}>
    {!supported && <p>更新日历服务后可配置日报联动。</p>}
    {error && <p className="wl-error" role="alert">{error}</p>}
    {supported && !report && !error && <p role="status">正在读取日历设置…</p>}
    {report && <div className="wc-preference">
      <label className="wl-check"><input type="checkbox" checked={pendingToggle?.enabled ?? report.enabled} disabled={busy} aria-describedby={descriptionId}
        onChange={e => action('/calendar-report-settings', { enabled: e.target.checked })} /><strong>日报生成后自动更新当天目标</strong></label>
      <p className="wl-muted" id={descriptionId}>按日报所属日期自动核对目标。有明确完成证据时勾选完成，有部分进展时补写「每日进度」。缺少证据时保留原状，手工填写的进度优先。</p>
      {report.last && <p className="wl-muted" role="status">{report.last.day} · {report.last.message || '等待核对'}</p>}
      {recheckSupported && <button type="button" disabled={busy || !report.enabled} onClick={async () => {
        const result = await action('/calendar-report-recheck', { from: addDays(today, -6), to: today })
        if (result?.recheck) setRecheckMessage(result.recheck.queued ? `已安排核对 ${result.recheck.queued} 天的已有日报，人工进度会保留。` : '没有需要重新核对的日报，或已在核对队列中。')
      }}>核对最近 7 天的已有日报</button>}
      {recheckMessage && <p className="wl-muted" role="status">{recheckMessage}</p>}
    </div>}
    {value?.workdays && <WorkdayPreferences value={value.workdays} busy={busy} action={action} onDirty={setDirty} />}
  </Dialog>
}

export function CalendarAccounts({ close, zone, supported, onCalendarChanged }) {
  const { value, error, busy, pendingToggle, action } = useCalendarSettings(supported)
  const [selected, setSelected] = useState('icloud')
  const [mappingDirty, setMappingDirty] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [account, setAccount] = useState(''), [password, setPassword] = useState('')
  const [connecting, setConnecting] = useState(false), [calendars, setCalendars] = useState(null), [calendar, setCalendar] = useState('')
  function resetConnection() {
    setAccount(''); setPassword(''); setCalendars(null); setCalendar(''); setConnecting(false)
  }
  async function update(path, data, connected) {
    const result = await action(path, data)
    if (!result) return
    if (path === '/calendar-icloud-discover') {
      setCalendars(result.calendars); setCalendar('')
    }
    if (connected) resetConnection()
  }
  const icloud = value?.icloud
  const seenSync = useRef(undefined)
  const last = icloud?.last
  useEffect(() => {
    if (!icloud) return
    const stamp = last?.time ?? null
    const previous = seenSync.current
    seenSync.current = stamp
    if (previous !== undefined && stamp !== previous && last?.state === 'ok' && (last.pulled > 0 || last.removed > 0)) onCalendarChanged()
  }, [icloud, last, onCalendarChanged])
  return <Dialog title="日历账号" className="wc-account-dialog" close={close} busy={busy} protectChanges dirty={!!password || !!account || mappingDirty}>
    <div className="wc-account-layout">
      <nav className="wc-account-nav" aria-label="日历服务">
        <button type="button" aria-pressed={selected === 'icloud'} disabled={busy} onClick={() => setSelected('icloud')}>
          <span>iCloud</span><small>{icloud?.connected ? '已连接' : '未连接'}</small>
        </button>
        <button type="button" aria-pressed={selected === 'google'} disabled={busy} onClick={() => setSelected('google')}>
          <span>Google</span><small>尚未接入</small>
        </button>
      </nav>
      <section className="wc-account-content" aria-label={selected === 'icloud' ? 'iCloud 配置' : 'Google 日历配置'}>
      {selected === 'google' ? <>
        <h3>Google 日历</h3>
        <p className="wl-muted">尚未开放连接。</p>
      </> : <>
        <h3>iCloud 日历</h3>
        {!supported && <p>更新日历服务后可连接 iCloud。</p>}
        {error && <p className="wl-error" role="alert">{error}</p>}
        {supported && !icloud && !error && <p role="status">正在读取连接…</p>}
        {icloud && <>
        <p className="wl-muted">在知识库和 Apple 日历之间按分组同步目标、日程、提醒的标题、时段、备注和通知时间。</p>
        {icloud.enabled && <p className="wl-muted">约每 5 分钟检查 iCloud 变更，拉取后自动更新工作日历。要提前检查，可点「立即同步」。</p>}
        {icloud.connected && <label className="wl-check"><input type="checkbox" checked={pendingToggle?.enabled ?? icloud.enabled} disabled={busy}
          onChange={e => update('/calendar-icloud-toggle', { enabled: e.target.checked })} />开启账号同步</label>}
        {icloud.connected && <div className="wc-settings-connection">
          <strong>{icloud.account || icloud.name}</strong>{icloud.since && <small>从 {icloud.since} 开始</small>}
          <button type="button" disabled={busy || !icloud.enabled || icloud.running} onClick={() => update('/calendar-icloud-sync', {})}>{icloud.running ? '同步中…' : '立即同步'}</button>
        </div>}
        {icloud.last && <p role="status" className="wl-muted">{icloud.last.state === 'ok'
          ? `最近同步 ${localParts(icloud.last.time, zone).time} · 从 iCloud 更新 ${icloud.last.pulled} 项 · 上传 ${icloud.last.pushed} 项${icloud.last.removed ? ` · 删除 ${icloud.last.removed} 项` : ''}`
          : icloud.last.message}</p>}
        {icloud.connected && value.groups && <ICloudMappings icloud={icloud} groups={value.groups.items} busy={busy} action={action} dirtyChanged={setMappingDirty} />}
        {connecting ? <div className="wc-settings-connect">
          <label>Apple 账户<input type="email" autoComplete="off" spellCheck={false} value={account} disabled={busy}
            onChange={e => { setAccount(e.target.value); setCalendars(null); setCalendar('') }} /></label>
          <label>应用专用密码<input type="password" autoComplete="new-password" value={password} disabled={busy}
            onChange={e => { setPassword(e.target.value); setCalendars(null); setCalendar('') }} /></label>
          <a href="https://account.apple.com/" target="_blank" rel="noreferrer">在 Apple 账户生成应用专用密码</a>
          {calendars && <label>同步日历<select value={calendar} onChange={e => setCalendar(e.target.value)} disabled={busy}>
            <option value="">{calendars.length ? '选择一个可写日历' : '没有可写日历'}</option>
            {calendars.map(item => <option key={item.id} value={item.id} disabled={item.writable === false}>{item.name}{item.writable === false ? '（只读）' : ''}</option>)}
          </select></label>}
          <div className="wl-actions">
            <button type="button" disabled={busy} onClick={resetConnection}>取消连接</button>
            <button type="button" disabled={busy || !account.trim() || !password}
              onClick={() => update('/calendar-icloud-discover', { account, password })}>验证并读取日历</button>
            {calendars && <button type="button" disabled={busy || !calendar} className="wl-primary"
              onClick={() => update('/calendar-icloud-connect', { account, password, calendar }, true)}>保存连接</button>}
          </div>
        </div> : <div className="wl-actions">
          <button type="button" disabled={busy} onClick={() => setConnecting(true)}>{icloud.connected ? '更换连接' : '登录 iCloud'}</button>
          {icloud.connected && <button type="button" disabled={busy} onClick={() => update('/calendar-icloud-disconnect', {}, true)}>断开连接</button>}
        </div>}
        {!!icloud.issues.length && <div className="wc-sync-issues">
          <h3>待处理</h3>
          {icloud.issues.map(issue => <details key={`${issue.groupId}:${issue.uid}`}>
            <summary>{issue.groupName && `${issue.groupName} · `}{issue.title} · {issues[issue.type] || issue.type}</summary>
            {issue.type === 'conflict' && <>
              <p>知识库 · {summary(issue.local, zone)}</p>
              {issue.local?.description && <p className="wc-sync-note">备注 · {issue.local.description}</p>}
              <p>iCloud · {summary(issue.icloud, zone)}</p>
              {issue.icloud?.description && <p className="wc-sync-note">备注 · {issue.icloud.description}</p>}
              <div className="wl-actions">
                <button type="button" disabled={busy || !icloud.enabled || icloud.running} onClick={() => update('/calendar-icloud-resolve', { groupId: issue.groupId, uid: issue.uid, key: issue.key, choice: 'knowledge' })}>采用知识库</button>
                <button type="button" disabled={busy || !icloud.enabled || icloud.running} onClick={() => update('/calendar-icloud-resolve', { groupId: issue.groupId, uid: issue.uid, key: issue.key, choice: 'icloud' })}>采用 iCloud</button>
              </div>
            </>}
            {issue.type === 'local-missing' && <>
              <p>{summary(issue.icloud, zone)}</p>
              {issue.icloud?.description && <p className="wc-sync-note">备注 · {issue.icloud.description}</p>}
              <div className="wl-actions">
                {confirmDelete === issue.key ? <>
                  <button type="button" onClick={() => setConfirmDelete(null)}>取消</button>
                  <button type="button" className="wc-delete" disabled={busy || !icloud.enabled || icloud.running} onClick={async () => {
                    await update('/calendar-icloud-resolve', { groupId: issue.groupId, uid: issue.uid, key: issue.key, choice: 'remove-icloud' })
                    setConfirmDelete(null)
                  }}>确认从 iCloud 删除</button>
                </> : <>
                  <button type="button" disabled={busy || !icloud.enabled || icloud.running} onClick={() =>
                    update('/calendar-icloud-resolve', { groupId: issue.groupId, uid: issue.uid, key: issue.key, choice: 'keep-icloud' })}>仅保留 iCloud</button>
                  <button type="button" disabled={busy || !icloud.enabled || icloud.running} onClick={() => setConfirmDelete(issue.key)}>从 iCloud 删除</button>
                </>}
              </div>
            </>}
            {issue.type === 'remote-missing' && <div className="wl-actions">
              <button type="button" disabled={busy || !icloud.enabled || icloud.running} onClick={() =>
                update('/calendar-icloud-resolve', { groupId: issue.groupId, uid: issue.uid, key: issue.key, choice: 'keep-knowledge' })}>仅保留 DSH</button>
              <button type="button" disabled={busy || !icloud.enabled || icloud.running} onClick={() => update('/calendar-icloud-resolve', { groupId: issue.groupId, uid: issue.uid, key: issue.key, choice: 'restore-icloud' })}>恢复到 iCloud</button>
              <button type="button" disabled={busy || !icloud.enabled || icloud.running} onClick={() => update('/calendar-icloud-resolve', { groupId: issue.groupId, uid: issue.uid, key: issue.key, choice: 'remove-knowledge' })}>接受删除并移入回收站</button>
            </div>}
          </details>)}
        </div>}
        </>}
      </>}
      </section>
    </div>
  </Dialog>
}
