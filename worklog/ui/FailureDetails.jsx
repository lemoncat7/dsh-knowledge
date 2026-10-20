import { useEffect, useState } from 'react'
import { api } from './api.js'

export function FailureDetails({ day, jobId, onEvidence }) {
  const [value, setValue] = useState(null), [page, setPage] = useState(0), [error, setError] = useState('')
  const [loading, setLoading] = useState(true), [version, setVersion] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    api(`/failure?day=${day}&id=${encodeURIComponent(jobId)}&page=${page}`, undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) setValue(result) })
      .catch(e => { if (!controller.signal.aborted) setError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [day, jobId, page, version])
  return <div className="wl-failure" aria-busy={loading}>
    {error && <p role="alert">{error} <button onClick={() => setVersion(value => value + 1)}>重新加载</button></p>}
    {!value && loading && <p role="status">正在读取失败详情…</p>}
    {value && <>
      <p>{value.detail ? `${value.detail.phase}${value.detail.batch ? ` · 第 ${value.detail.batch} 批` : ''} · ${value.detail.total} 处引用异常` : `错误类型：${value.code || '未记录'}`}</p>
      {value.detail ? <>
        <p className="wl-muted">{value.detail.repairAttempted ? '已尝试一次引用修正，仍未通过验证。' : '引用格式边界不明确或错误过多，未自动修正。'}原日报未被覆盖；可查看下方位置及本批素材后重新整理，无需修改源记录编号。</p>
        {value.detail.repairResult === 'timeout_or_cancelled' && <p>修正请求超时或被取消。</p>}
        {value.detail.issues.map((issue, index) => <section key={index}>
          <h3>第 {issue.line} 行 · {issue.code === 'invalid_reference_format' ? '引用格式错误' : '编号不存在'}</h3>
          <p>错误引用：<code>{issue.reference || '（空）'}</code></p>
          <pre>{issue.excerpt}</pre>
        </section>)}
        {value.detail.total > value.detail.issues.length && <p className="wl-muted">仅保留前 {value.detail.issues.length} 处，避免加载过多内容。</p>}
      </> : <p className="wl-muted">这次任务没有保留具体引用位置（旧版失败记录无法还原）。重新整理后若仍失败，这里会显示新的定位详情。</p>}
      <details><summary>本次输入素材 · {value.total} 条</summary>
        {!value.detail && <p className="wl-muted">短编号仅用于本次查看，不代表旧模型输入编号。</p>}
        <div className="wl-failure-sources">{value.sources.map(source => <button key={source.id} disabled={loading} onClick={() => onEvidence(source.id)}><code>{source.alias}</code><span>{source.project || '未指定项目'}</span></button>)}</div>
        {value.total > value.limit && <div className="wl-actions"><button disabled={loading || !page} onClick={() => setPage(value => value - 1)}>上一页</button><span>第 {value.page + 1} 页</span><button disabled={loading || (value.page + 1) * value.limit >= value.total} onClick={() => setPage(value => value + 1)}>下一页</button></div>}
      </details>
    </>}
  </div>
}
