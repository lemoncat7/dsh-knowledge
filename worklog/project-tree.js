// Display hierarchy only. Original endpoint paths are kept for exact-match capture.
export function directoryChain(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return []
  const slash = value.replace(/\\/g, '/')
  let root, rest, windows = false
  if (/^[a-z]:\//i.test(slash)) {
    windows = true; root = slash.slice(0, 2) + '/'; rest = slash.slice(3)
  } else if (/^[\\/]{2}[^\\/]/.test(value)) {
    const unc = /^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(slash)
    if (unc && !['.', '?', '..'].includes(unc[1]) && !['.', '..'].includes(unc[2])) {
      windows = true; root = `//${unc[1]}/${unc[2]}`; rest = unc[3] || ''
    }
  } else if (value.startsWith('/')) { root = '/'; rest = value.slice(1) }
  if (!root) return [{ key: JSON.stringify(['exact', value]), path: value, label: value }]
  const parts = []
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  const chain = [], keys = [windows ? root.toLowerCase() : root]
  let path = root
  chain.push({ key: JSON.stringify(keys), path, label: root })
  for (const part of parts) {
    path += (path.endsWith('/') ? '' : '/') + part
    keys.push(windows ? part.toLowerCase() : part)
    chain.push({ key: JSON.stringify(keys), path, label: part })
  }
  return chain
}

export function buildProjectTree(paths) {
  const nodes = new Map(), roots = []
  for (const path of new Set(paths)) {
    let parent = null
    for (const part of directoryChain(path)) {
      let node = nodes.get(part.key)
      if (!node) {
        node = { ...part, parent, paths: [], children: [] }
        nodes.set(node.key, node)
        if (parent) nodes.get(parent).children.push(node)
        else roots.push(node)
      }
      parent = node.key
    }
    if (parent) nodes.get(parent).paths.push(path)
  }
  const compare = (a, b) => a.label.localeCompare(b.label, 'zh-CN', { numeric: true })
  roots.sort(compare)
  for (const node of nodes.values()) node.children.sort(compare)
  return { roots, nodes }
}

export function projectAncestors(paths) {
  return new Set(paths.flatMap(path => directoryChain(path).slice(0, -1).map(node => node.key)))
}

export function visibleProjectRows(roots, expanded) {
  const rows = [], pending = roots.map((node, i) => ({ node, depth: 0, position: i + 1, size: roots.length })).reverse()
  while (pending.length) {
    const row = pending.pop(); rows.push(row)
    if (expanded.has(row.node.key)) {
      for (let i = row.node.children.length - 1; i >= 0; i--) pending.push({ node: row.node.children[i], depth: row.depth + 1, position: i + 1, size: row.node.children.length })
    }
  }
  return rows
}
