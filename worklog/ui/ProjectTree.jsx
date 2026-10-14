import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { buildProjectTree, directoryChain, projectAncestors, visibleProjectRows } from '../project-tree.js'

export function ProjectTree({ projects, selected, recursive, currentProject, defaultProject = '', onChange, onSelectCurrent }) {
  const { roots, nodes } = useMemo(() => buildProjectTree([...projects, ...selected, currentProject].filter(Boolean)), [projects, selected, currentProject])
  // Reveal the Host default directory itself, not its children or selected/session paths.
  // Only seed on mount: polling and session changes must not undo a user's collapse.
  const [expanded, setExpanded] = useState(() => projectAncestors([defaultProject]))
  const [focused, setFocused] = useState('')
  const previous = useRef(new Set(selected)), refs = useRef(new Map()), helpId = useId()
  useLayoutEffect(() => {
    const added = selected.filter(path => !previous.current.has(path))
    previous.current = new Set(selected)
    if (added.length) setExpanded(old => new Set([...old, ...projectAncestors(added)]))
  }, [selected])
  const rows = visibleProjectRows(roots, expanded)
  const selectedSet = new Set(selected)
  const selectedNodes = new Set(selected.map(path => directoryChain(path).at(-1)?.key))
  const currentKey = directoryChain(currentProject).at(-1)?.key
  const descendantCounts = new Map()
  for (const key of selectedNodes) {
    let parent = nodes.get(key)?.parent
    while (parent) { descendantCounts.set(parent, (descendantCounts.get(parent) || 0) + 1); parent = nodes.get(parent)?.parent }
  }
  const active = rows.some(row => row.node.key === focused) ? focused : rows.find(row => selectedNodes.has(row.node.key) || row.node.key === currentKey)?.node.key || rows[0]?.node.key
  const values = node => node.paths.length ? node.paths : [node.path]
  const explicit = node => values(node).some(path => selectedSet.has(path))
  const partial = node => !recursive && explicit(node) && values(node).some(path => !selectedSet.has(path))
  const inherited = node => {
    if (!recursive || explicit(node)) return false
    let parent = node.parent
    while (parent) { if (selectedNodes.has(parent)) return true; parent = nodes.get(parent)?.parent }
    return false
  }
  function focus(key) { setFocused(key); refs.current.get(key)?.focus() }
  function expand(node, open) { setExpanded(old => { const next = new Set(old); if (open) next.add(node.key); else next.delete(node.key); return next }) }
  function toggle(node) {
    if (inherited(node)) return
    const paths = values(node)
    onChange(explicit(node) && !partial(node) ? selected.filter(path => !paths.includes(path)) : [...new Set([...selected, ...paths])])
  }
  function keyDown(event, row, index) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const node = row.node
    switch (event.key) {
      case 'ArrowDown': focus(rows[Math.min(index + 1, rows.length - 1)].node.key); break
      case 'ArrowUp': focus(rows[Math.max(index - 1, 0)].node.key); break
      case 'Home': focus(rows[0].node.key); break
      case 'End': focus(rows.at(-1).node.key); break
      case 'ArrowRight': if (node.children.length) { if (expanded.has(node.key)) focus(node.children[0].key); else expand(node, true) } break
      case 'ArrowLeft': if (node.children.length && expanded.has(node.key)) expand(node, false); else if (node.parent) focus(node.parent); break
      case ' ': toggle(node); break
      case 'Enter': if (node.children.length) expand(node, !expanded.has(node.key)); else toggle(node); break
      default: return
    }
    event.preventDefault(); event.stopPropagation()
  }
  return <section className="wl-directory-picker" aria-label="采集目录选择">
    <span id={helpId} className="wl-sr">展开不改变勾选；方向键浏览，空格勾选。</span>
    <div className="wl-directory-toolbar"><span className="wl-muted">已选 {selectedNodes.size} 个目录</span><div>
      {currentProject && onSelectCurrent && <button type="button" title={currentProject} aria-label="勾选当前工作目录" onClick={onSelectCurrent}>当前目录</button>}
      <button type="button" disabled={!expanded.size} onClick={() => setExpanded(new Set())}>收起全部</button>
    </div></div>
    {rows.length ? <div className="wl-directory-tree" role="tree" aria-label="工作目录树" aria-multiselectable="true" aria-describedby={helpId}>
      {rows.map((row, index) => {
        const { node, depth } = row, included = inherited(node), checked = explicit(node), count = descendantCounts.get(node.key) || 0
        const mixed = partial(node)
        const status = [node.key === currentKey ? '当前会话' : '', included ? '上级已包含' : mixed ? '部分路径写法已选' : checked ? '已勾选' : count ? `下级已选 ${count}` : ''].filter(Boolean).join(' · ')
        const badge = node.key === currentKey ? '当前' : included ? '已包含' : mixed ? '部分已选' : !checked && count ? `已选 ${count}` : ''
        return <div key={node.key} ref={el => { if (el) refs.current.set(node.key, el); else refs.current.delete(node.key) }} className="wl-directory-row" role="treeitem" aria-label={`${node.path}${status ? `，${status}` : ''}`} aria-level={depth + 1} aria-posinset={row.position} aria-setsize={row.size} aria-expanded={node.children.length ? expanded.has(node.key) : undefined} aria-checked={mixed ? 'mixed' : checked || included} tabIndex={active === node.key ? 0 : -1} style={{ '--wl-tree-depth': Math.min(depth, 5) }} onFocus={() => setFocused(node.key)} onKeyDown={e => keyDown(e, row, index)}>
          {node.children.length ? <button className="wl-directory-expand" type="button" tabIndex={-1} aria-label={`${expanded.has(node.key) ? '收起' : '展开'} ${node.path}`} aria-expanded={expanded.has(node.key)} onClick={() => { focus(node.key); expand(node, !expanded.has(node.key)) }}><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d={expanded.has(node.key) ? 'm4 6 4 4 4-4' : 'm6 4 4 4-4 4'} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></button> : <span className="wl-directory-spacer" aria-hidden="true" />}
          <label className="wl-check wl-directory-label"><input type="checkbox" tabIndex={-1} aria-label={`采集目录 ${node.path}`} ref={el => { if (el) el.indeterminate = mixed }} checked={checked || included} disabled={included} onChange={() => { toggle(node); focus(node.key) }} /><span className="wl-directory-name" title={node.path}><span className="wl-directory-title">{node.label}</span></span>{badge && <small className="wl-directory-badge" title={status}>{badge}</small>}</label>
        </div>
      })}
    </div> : <p className="wl-muted">还没有已知工作目录，可在下方手动添加。</p>}
  </section>
}
