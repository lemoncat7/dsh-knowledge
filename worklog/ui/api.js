export async function api(path, data, signal) {
  const response = await fetch(`/worklog-control/v1${path}`, {
    method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal,
    headers: { 'x-dsh-worklog-client': 'workspace', ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  })
  const raw = await response.text()
  let result
  try { result = JSON.parse(raw) } catch { throw new Error(`工作记录接口返回 HTTP ${response.status}，请检查插件与远程访问路由。`) }
  if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`)
  return result
}

