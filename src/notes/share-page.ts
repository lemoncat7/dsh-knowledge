import type { NoteNode, NoteShare } from './domain.js'

export interface NoteSharePageInput {
  apiPrefix: string
  share: NoteShare
  nodes: NoteNode[]
  selectedNode?: NoteNode
  selectedText?: string
  contentTruncated?: boolean
  listTruncated?: boolean
}

export function renderNoteSharePage(input: NoteSharePageInput): string {
  const { share, nodes } = input
  const baseHref = `${input.apiPrefix.replace(/\/$/, '')}/shared/${encodeURIComponent(share.token)}`
  const paths = relativePaths(share.node, nodes)
  const items = nodes
    .filter(node => node.id !== share.noteId)
    .sort((left, right) => (paths.get(left.id) ?? left.name).localeCompare(paths.get(right.id) ?? right.name, 'zh-CN'))
  const selected = input.selectedNode
  const selectedPath = selected === undefined ? '' : paths.get(selected.id) ?? selected.name
  const title = share.node.name
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} · 分享笔记</title>
<style>${SHARE_PAGE_CSS}</style></head><body>
<main class="share-shell">
  <header class="share-header"><div><span class="eyebrow">DSH KNOWLEDGE</span><h1>${escapeHtml(title)}</h1><p>${share.node.kind === 'folder' ? `共享目录 · ${Math.max(0, nodes.length - 1)} 个项目` : '共享笔记文档 · 只读'}</p></div><span class="readonly">只读分享</span></header>
  <div class="share-workspace${share.node.kind === 'folder' ? '' : ' is-single'}">
    ${share.node.kind === 'folder' ? `<nav class="share-tree" aria-label="共享目录"><a class="tree-root" href="${escapeAttribute(baseHref)}">${escapeHtml(share.node.name)}</a>${items.map(node => renderTreeItem(node, paths.get(node.id) ?? node.name, baseHref, selected?.id === node.id)).join('')}${input.listTruncated ? '<p class="notice">目录内容较多，仅展示前 500 项。</p>' : ''}</nav>` : ''}
    <section class="share-content">${renderSharedContent(selected ?? share.node, selectedPath || share.node.name, input.selectedText, input.contentTruncated, baseHref)}</section>
  </div>
  <footer class="share-footer"><span>分享于 ${formatDate(share.createdAt)}</span><span>内容会随原笔记更新</span></footer>
</main></body></html>`
}

function renderTreeItem(node: NoteNode, path: string, baseHref: string, active: boolean): string {
  const depth = Math.max(0, path.split('/').length - 2)
  if (node.kind === 'folder') {
    return `<div class="tree-item is-folder" style="--depth:${depth}"><span class="tree-icon" aria-hidden="true"></span><span>${escapeHtml(node.name)}</span></div>`
  }
  const href = `${baseHref}?note=${encodeURIComponent(node.id)}`
  return `<a class="tree-item is-file${active ? ' is-active' : ''}" style="--depth:${depth}" href="${escapeAttribute(href)}"${active ? ' aria-current="page"' : ''}><span class="file-icon" aria-hidden="true"></span><span>${escapeHtml(node.name)}</span></a>`
}

function renderSharedContent(node: NoteNode, path: string, text: string | undefined, truncated: boolean | undefined, baseHref: string): string {
  if (node.kind === 'folder') {
    return '<div class="empty"><span class="empty-mark" aria-hidden="true"></span><h2>选择一篇文档</h2><p>从左侧共享目录中选择要阅读的内容。</p></div>'
  }
  const download = `${baseHref}/content?noteId=${encodeURIComponent(node.id)}&download=1`
  const heading = `<header class="content-header"><div><span>${escapeHtml(path)}</span><h2>${escapeHtml(node.name)}</h2></div><a class="download" href="${escapeAttribute(download)}">下载</a></header>`
  if (node.mediaType?.startsWith('image/')) {
    const source = `${baseHref}/content?noteId=${encodeURIComponent(node.id)}`
    return `${heading}<div class="image-stage"><img src="${escapeAttribute(source)}" alt="${escapeAttribute(node.name)}"></div>`
  }
  if (text !== undefined) {
    return `${heading}${truncated ? '<p class="notice content-notice">文档较长，网页仅显示前 512 KiB；下载可查看完整内容。</p>' : ''}<article class="document"><pre>${escapeHtml(text)}</pre></article>`
  }
  return `${heading}<div class="empty"><span class="file-large" aria-hidden="true"></span><h2>此格式不支持网页预览</h2><p>可以下载后使用本地应用打开。</p><a class="download primary" href="${escapeAttribute(download)}">下载文件</a></div>`
}

function relativePaths(root: NoteNode, nodes: NoteNode[]): Map<string, string> {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const paths = new Map<string, string>([[root.id, root.name]])
  const resolve = (node: NoteNode, seen = new Set<string>()): string => {
    const cached = paths.get(node.id)
    if (cached !== undefined) return cached
    if (seen.has(node.id) || node.parentId === null) return node.name
    seen.add(node.id)
    const parent = byId.get(node.parentId)
    const value = parent === undefined ? node.name : `${resolve(parent, seen)}/${node.name}`
    paths.set(node.id, value)
    return value
  }
  for (const node of nodes) resolve(node)
  return paths
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function escapeAttribute(value: string): string {
  return escapeHtml(value)
}

const SHARE_PAGE_CSS = `
*{box-sizing:border-box}html{font-family:Inter,"SF Pro Text","PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:#eef0f2;color:#202428}body{min-width:0;min-height:100dvh;margin:0;padding:clamp(12px,3vw,36px);background:radial-gradient(circle at 14% 4%,rgba(255,255,255,.92),transparent 34%),#eef0f2}button,input,select,textarea,a{font:inherit}.share-shell{width:min(1180px,100%);min-height:calc(100dvh - clamp(24px,6vw,72px));margin:0 auto;overflow:hidden;border:1px solid rgba(25,31,36,.13);border-radius:20px;background:rgba(250,251,252,.82);box-shadow:0 18px 58px rgba(24,30,35,.11);backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px)}.share-header{min-height:98px;display:flex;align-items:center;justify-content:space-between;gap:24px;border-bottom:1px solid rgba(25,31,36,.1);padding:20px 24px}.eyebrow{display:block;color:#737b82;font:650 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em}.share-header h1{margin:7px 0 0;font-size:clamp(20px,2.6vw,30px);line-height:1.2;letter-spacing:-.025em}.share-header p{margin:5px 0 0;color:#767e85;font-size:12px}.readonly{flex:none;border:1px solid rgba(25,31,36,.12);border-radius:999px;padding:7px 10px;background:rgba(255,255,255,.62);color:#626a70;font-size:11px}.share-workspace{min-height:calc(100dvh - 220px);display:grid;grid-template-columns:minmax(220px,280px) minmax(0,1fr)}.share-workspace.is-single{grid-template-columns:minmax(0,1fr)}.share-tree{min-width:0;border-right:1px solid rgba(25,31,36,.1);padding:12px 9px;background:rgba(240,242,244,.56)}.tree-root,.tree-item{min-width:0;min-height:38px;display:flex;align-items:center;gap:9px;border:0;border-radius:9px;padding:7px 9px;color:#4d555b;font-size:12px;text-decoration:none}.tree-root{margin-bottom:6px;color:#202428;font-weight:650}.tree-item{padding-left:calc(9px + var(--depth)*14px)}a.tree-item:hover,a.tree-item:focus-visible{background:rgba(255,255,255,.78);color:#202428;outline:none}.tree-item.is-active{background:#fff;color:#202428;box-shadow:inset 2px 0 0 #555e65,0 1px 5px rgba(25,31,36,.08)}.tree-icon,.file-icon{position:relative;width:17px;height:13px;flex:none;border:1px solid #8a9298;border-radius:3px;background:rgba(255,255,255,.58)}.tree-icon:before{position:absolute;top:-4px;left:1px;width:8px;height:4px;border:1px solid #8a9298;border-bottom:0;border-radius:3px 3px 0 0;background:inherit;content:""}.file-icon{width:14px;height:17px}.share-content{min-width:0;display:grid;grid-template-rows:auto minmax(0,1fr);background:rgba(255,255,255,.38)}.content-header{min-height:72px;display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:1px solid rgba(25,31,36,.09);padding:14px clamp(16px,3vw,32px)}.content-header span{display:block;max-width:70vw;overflow:hidden;color:#7b8389;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.content-header h2{margin:5px 0 0;font-size:18px;letter-spacing:-.015em}.download{min-height:38px;display:inline-flex;align-items:center;justify-content:center;border:1px solid rgba(25,31,36,.15);border-radius:9px;padding:7px 13px;background:rgba(255,255,255,.72);color:#30363b;font-size:12px;font-weight:620;text-decoration:none}.download:hover,.download:focus-visible{border-color:rgba(25,31,36,.38);background:#fff;outline:2px solid transparent}.download.primary{margin-top:10px;background:#30363b;color:#fff}.document{min-width:0;padding:clamp(24px,5vw,64px)}.document pre{max-width:820px;margin:0 auto;color:#30363b;font:14px/1.78 "SFMono-Regular",Consolas,"Liberation Mono",monospace;white-space:pre-wrap;overflow-wrap:anywhere}.image-stage{min-height:0;display:grid;place-items:center;padding:24px}.image-stage img{max-width:100%;max-height:72dvh;border-radius:12px;box-shadow:0 10px 34px rgba(25,31,36,.12)}.empty{min-height:420px;display:grid;place-content:center;justify-items:center;padding:32px;color:#767e85;text-align:center}.empty h2{margin:14px 0 0;color:#30363b;font-size:17px}.empty p{margin:6px 0 0;font-size:12px}.empty-mark,.file-large{width:54px;height:39px;border:1.5px solid #939ba1;border-radius:7px;background:rgba(255,255,255,.55)}.file-large{width:40px;height:50px}.notice{margin:10px 7px;border-left:2px solid #7e878e;padding:6px 9px;color:#717980;font-size:11px;line-height:1.5}.content-notice{margin:16px clamp(16px,3vw,32px) 0}.share-footer{min-height:48px;display:flex;align-items:center;justify-content:space-between;gap:16px;border-top:1px solid rgba(25,31,36,.1);padding:10px 18px;color:#7a8288;font-size:10px}
@media(max-width:720px){body{padding:0}.share-shell{min-height:100dvh;border:0;border-radius:0}.share-header{min-height:88px;padding:16px}.readonly{display:none}.share-workspace{min-height:calc(100dvh - 185px);grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}.share-tree{max-height:34dvh;overflow:auto;border-right:0;border-bottom:1px solid rgba(25,31,36,.1)}.content-header{padding-inline:16px}.document{padding:24px 17px 44px}.download{min-height:44px}.share-footer{align-items:flex-start;flex-direction:column;gap:3px;padding:11px 16px}}
@media(prefers-color-scheme:dark){html{background:#17191b;color:#ebedef}body{background:radial-gradient(circle at 14% 4%,rgba(255,255,255,.055),transparent 34%),#17191b}.share-shell{border-color:rgba(255,255,255,.11);background:rgba(31,34,37,.88);box-shadow:0 18px 58px rgba(0,0,0,.36)}.share-header,.content-header,.share-footer{border-color:rgba(255,255,255,.09)}.eyebrow,.share-header p,.content-header span,.empty,.notice,.share-footer{color:#9ba1a6}.share-header h1,.content-header h2,.empty h2,.tree-root{color:#eef0f2}.readonly,.download{border-color:rgba(255,255,255,.13);background:rgba(255,255,255,.06);color:#d9dcde}.share-tree{border-color:rgba(255,255,255,.09);background:rgba(15,17,18,.25)}.tree-item{color:#b5babd}a.tree-item:hover,a.tree-item:focus-visible,.tree-item.is-active{background:rgba(255,255,255,.08);color:#f1f2f3}.tree-item.is-active{box-shadow:inset 2px 0 0 #b8bec2,0 1px 7px rgba(0,0,0,.2)}.tree-icon,.file-icon,.empty-mark,.file-large{border-color:#777f85;background:rgba(255,255,255,.04)}.share-content{background:rgba(255,255,255,.015)}.document pre{color:#d9dcde}.download:hover,.download:focus-visible{border-color:rgba(255,255,255,.34);background:rgba(255,255,255,.1)}.download.primary{background:#e3e6e8;color:#202326}}
`
