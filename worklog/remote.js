import { fail } from './domain.js'

export function destination(connection) {
  if (connection.backend !== 'remote') return null
  const url = new URL(connection.remoteUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail('中央知识库地址无效')
  return url.href.replace(/\/+$/, '')
}

export async function requestCentral(connection, method, path, data, query = new URLSearchParams(), signal) {
  const base = destination(connection)
  if (!base || !connection.remoteToken) throw fail('请先配置中央知识库连接', 409)
  const controller = new AbortController(), abort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, Math.min(120000, Math.max(1000, connection.remoteTimeoutMs || 15000)))
  try {
    const response = await fetch(`${base}/worklog${path}${query.size ? `?${query}` : ''}`, {
      method, redirect: 'manual', signal: controller.signal,
      headers: { authorization: `Bearer ${connection.remoteToken}`, accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(data) } : {}),
    })
    const chunks = []; let size = 0
    for await (const chunk of response.body || []) {
      size += chunk.length
      if (size > 10 * 1024 * 1024) { controller.abort(); throw fail('中央日报响应过大', 502) }
      chunks.push(Buffer.from(chunk))
    }
    if (response.status >= 300 && response.status < 400) throw fail('中央日报接口发生重定向，请检查知识库地址；未转发凭据', 502)
    if (response.status === 404) throw fail('中央知识库尚未支持统一日报，请先升级中央插件', 502)
    if (response.status === 401 || response.status === 403) throw fail('中央日报授权不足或已失效，请检查知识库令牌权限', response.status)
    let value
    try { value = JSON.parse(Buffer.concat(chunks).toString()) } catch { throw fail('中央日报未返回有效 JSON，请检查中央服务', 502) }
    if (!response.ok) throw fail(typeof value.error === 'string' ? value.error.slice(0, 500) : '中央日报请求失败', response.status)
    return value
  } catch (e) {
    if (e.status) throw e
    throw fail('中央日报连接失败或超时；本地待上传素材仍保留，可稍后重试', 502)
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
}
