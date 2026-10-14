// Lexical matching only: never resolve against the server cwd or follow symlinks.
// Kept browser-safe because domain.js also supplies workspace defaults.
function absolutePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return null
  let root, rest, windows = false
  const slashes = value.replace(/\\/g, '/')
  if (/^[a-z]:\//i.test(slashes)) {
    windows = true; root = slashes.slice(0, 2); rest = slashes.slice(3)
  } else if (/^[\\/]{2}[^\\/]/.test(value)) {
    const unc = /^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(slashes)
    if (!unc || ['.', '?', '..'].includes(unc[1]) || ['.', '..'].includes(unc[2])) return null
    windows = true; root = `//${unc[1]}/${unc[2]}`; rest = unc[3] || ''
  } else if (value.startsWith('/')) {
    root = '/'; rest = value.slice(1)
  } else return null // Relative and drive-relative paths stay exact-only.
  const parts = []
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(windows ? part.toLowerCase() : part)
  }
  return { root: windows ? root.toLowerCase() : root, parts }
}

export function projectInScope(project, config) {
  if (config.scope === 'all' || config.projects.includes(project)) return true
  if (config.recursiveProjects !== true) return false
  const child = absolutePath(project)
  if (!child) return false
  return config.projects.some(value => {
    const parent = absolutePath(value)
    return parent && parent.root === child.root && parent.parts.length <= child.parts.length
      && parent.parts.every((part, i) => part === child.parts[i])
  })
}
