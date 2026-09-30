import { useEffect, useState } from 'react'
import { api } from './api.js'
import { Dialog } from './Dialog.jsx'

export function SyncStatus() {
  const [state, setState] = useState(null), [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController(); let timer
    async function poll() {
      try { if (!document.hidden) setState(await api('/collector-state', undefined, controller.signal)) }
      catch (e) { if (!controller.signal.aborted) setError(e.message) }
      finally { if (!controller.signal.aborted) timer = setTimeout(poll, 6000) }
    }
    void poll(); return () => { controller.abort(); clearTimeout(timer) }
  }, [])
  async function act(path) {
    setBusy(true); setError('')
    try { setState(await api(path, { confirm: true })); setConfirm(false) }
    catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  if (!state?.remote) return null
  return <>
    <div className="wl-sync-status">
      <span role="status">中央日报 · 本机待上传 {state.sync.pending} 条{state.sync.otherDestinations > 0 && ` · 另有 ${state.sync.otherDestinations} 条保留在原中央地址队列`}</span>
      {(error || state.sync.error) && <span role="alert">{error || state.sync.error}</span>}
      {state.sync.pending > 0 && <button disabled={busy} onClick={() => act('/retry-sync')}>重试上传</button>}
      {(state.localHistory > 0 || state.localReports > 0) && <button disabled={busy} onClick={() => setConfirm(true)}>迁移本地历史</button>}
    </div>
    {confirm && <Dialog title="迁移到当前中央知识库" close={() => !busy && setConfirm(false)}>
      <p>将上传本机原有素材及日报历史至当前连接的中央知识库。历史对话可能包含敏感信息，请确认当前中央服务可信且已授权。</p>
      <p>来源会去重；旧日报保存在中央的历史版本中，不覆盖中央正文。本地原始数据继续保留，不迁移本地定时配置或未完成的整理任务。</p>
      {error && <p role="alert">{error}</p>}
      <footer><button disabled={busy} onClick={() => setConfirm(false)}>取消</button><button disabled={busy} onClick={() => act('/migrate')}>{busy ? '加入队列…' : '确认上传历史'}</button></footer>
    </Dialog>}
  </>
}
