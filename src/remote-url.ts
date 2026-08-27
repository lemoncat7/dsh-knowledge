export function normalizeRemoteKnowledgeUrl(value: string): URL {
  const url = new URL(value.trim())
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('remote knowledge backend requires HTTPS (HTTP is allowed only for loopback testing)')
  }
  if (url.username || url.password) throw new Error('remote knowledge URL must not contain credentials')
  if (url.search || url.hash) throw new Error('remote knowledge URL must not contain a query string or fragment')
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`
  return url
}
