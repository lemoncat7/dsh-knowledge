import type { NoteNode, NoteShare } from './domain.js'
import { renderSharedMarkdown, type SharedMarkdownHeading } from './share-markdown.js'

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
  const selected = input.selectedNode
  const selectedPath = selected === undefined ? '' : paths.get(selected.id) ?? selected.name
  const rendered = renderSharedContent(selected ?? share.node, selectedPath || share.node.name, input.selectedText, input.contentTruncated, baseHref)
  const directory = share.node.kind === 'folder'
    ? renderDirectoryPanel(share.node, nodes, baseHref, selected?.id, input.listTruncated === true)
    : ''
  const outline = rendered.outline === undefined ? '' : renderOutlinePanel(rendered.outline)
  const panelClass = directory.length === 0 && outline.length === 0 ? ' is-single' : ''
  const title = share.node.name
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} · 分享笔记</title>
<style>${SHARE_PAGE_CSS}</style></head><body>
<main class="share-shell">
  <header class="share-header"><div class="share-title"><span class="eyebrow">DSH KNOWLEDGE</span><h1>${escapeHtml(title)}</h1><p>${share.node.kind === 'folder' ? `共享目录 · ${Math.max(0, nodes.length - 1)} 个项目` : '共享笔记文档 · 只读'}</p></div><span class="readonly">只读分享</span></header>
  <div class="share-workspace${panelClass}">
    ${directory}
    <section class="share-content">${rendered.html}</section>
    ${outline}
  </div>
  <footer class="share-footer"><span>分享于 ${formatDate(share.createdAt)}</span><span>内容会随原笔记更新</span></footer>
</main></body></html>`
}

function renderDirectoryPanel(root: NoteNode, nodes: NoteNode[], baseHref: string, selectedId: string | undefined, truncated: boolean): string {
  const children = childNodes(nodes)
  return `<details class="share-panel directory-panel" open>
    <summary class="panel-toggle">${directoryIcon()}<span class="panel-label">目录</span><span class="panel-count">${Math.max(0, nodes.length - 1)}</span>${chevronIcon()}</summary>
    <nav class="share-tree" aria-label="共享目录">
      <a class="tree-root" href="${escapeAttribute(baseHref)}">${folderIcon()}<span>${escapeHtml(root.name)}</span></a>
      ${renderTreeChildren(root.id, children, baseHref, selectedId, 0)}
      ${truncated ? '<p class="notice">目录内容较多，仅展示前 500 项。</p>' : ''}
    </nav>
  </details>`
}

function renderTreeChildren(parentId: string, children: Map<string, NoteNode[]>, baseHref: string, selectedId: string | undefined, depth: number): string {
  return (children.get(parentId) ?? []).map(node => {
    if (node.kind === 'folder') {
      const descendants = containsNode(node.id, selectedId, children)
      return `<details class="tree-folder"${depth === 0 || descendants ? ' open' : ''}>
        <summary class="tree-item is-folder" style="padding-left:${9 + depth * 14}px">${folderIcon()}<span>${escapeHtml(node.name)}</span>${chevronIcon()}</summary>
        <div class="tree-children">${renderTreeChildren(node.id, children, baseHref, selectedId, depth + 1)}</div>
      </details>`
    }
    const href = `${baseHref}?note=${encodeURIComponent(node.id)}`
    const active = node.id === selectedId
    return `<a class="tree-item is-file${active ? ' is-active' : ''}" style="padding-left:${9 + depth * 14}px" href="${escapeAttribute(href)}"${active ? ' aria-current="page"' : ''}>${fileIcon()}<span>${escapeHtml(node.name)}</span></a>`
  }).join('')
}

function childNodes(nodes: NoteNode[]): Map<string, NoteNode[]> {
  const result = new Map<string, NoteNode[]>()
  for (const node of nodes) {
    if (node.parentId === null) continue
    const siblings = result.get(node.parentId) ?? []
    siblings.push(node)
    result.set(node.parentId, siblings)
  }
  for (const siblings of result.values()) {
    siblings.sort((left, right) => {
      if (left.kind === 'folder' && right.kind !== 'folder') return -1
      if (left.kind !== 'folder' && right.kind === 'folder') return 1
      return left.name.localeCompare(right.name, 'zh-CN', { numeric: true })
    })
  }
  return result
}

function containsNode(rootId: string, selectedId: string | undefined, children: Map<string, NoteNode[]>): boolean {
  if (selectedId === undefined) return false
  const pending = [...(children.get(rootId) ?? [])]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    if (current.id === selectedId) return true
    pending.push(...(children.get(current.id) ?? []))
  }
  return false
}

function renderOutlinePanel(headings: SharedMarkdownHeading[]): string {
  return `<details class="share-panel outline-panel" open>
    <summary class="panel-toggle">${outlineIcon()}<span class="panel-label">大纲</span><span class="panel-count">${headings.length}</span>${chevronIcon()}</summary>
    <nav class="share-outline" aria-label="文档大纲">${headings.length === 0
      ? '<p class="outline-empty">这篇文档还没有标题。</p>'
      : headings.map(heading => `<a href="#${escapeAttribute(heading.id)}" style="padding-left:${8 + Math.min(3, Math.max(0, heading.depth - 1)) * 12}px">${escapeHtml(heading.text)}</a>`).join('')}</nav>
  </details>`
}

function renderSharedContent(node: NoteNode, path: string, text: string | undefined, truncated: boolean | undefined, baseHref: string): { html: string; outline?: SharedMarkdownHeading[] } {
  if (node.kind === 'folder') {
    return { html: '<div class="empty"><span class="empty-mark" aria-hidden="true"></span><h2>选择一篇文档</h2><p>从目录中选择要阅读的内容。</p></div>' }
  }
  const download = `${baseHref}/content?noteId=${encodeURIComponent(node.id)}&download=1`
  const heading = `<header class="content-header"><div class="content-title"><span>${escapeHtml(path)}</span><h2>${escapeHtml(node.name)}</h2></div><a class="download" href="${escapeAttribute(download)}">${downloadIcon()}<span>下载</span></a></header>`
  if (node.mediaType?.startsWith('image/')) {
    const source = `${baseHref}/content?noteId=${encodeURIComponent(node.id)}`
    return { html: `${heading}<div class="image-stage"><img src="${escapeAttribute(source)}" alt="${escapeAttribute(node.name)}"></div>` }
  }
  if (text !== undefined) {
    const notice = truncated ? '<p class="notice content-notice">文档较长，网页仅显示前 512 KiB；下载可查看完整内容。</p>' : ''
    if (isMarkdown(node)) {
      const markdown = renderSharedMarkdown(text)
      return { html: `${heading}${notice}<article class="document"><div class="markdown-body">${markdown.html}</div></article>`, outline: markdown.headings }
    }
    return { html: `${heading}${notice}<article class="document"><pre class="plain-text">${escapeHtml(text)}</pre></article>` }
  }
  return { html: `${heading}<div class="empty"><span class="file-large" aria-hidden="true"></span><h2>此格式不支持网页预览</h2><p>可以下载后使用本地应用打开。</p><a class="download primary" href="${escapeAttribute(download)}">${downloadIcon()}<span>下载文件</span></a></div>` }
}

function isMarkdown(node: NoteNode): boolean {
  const mediaType = node.mediaType?.toLocaleLowerCase() ?? ''
  const name = node.name.toLocaleLowerCase()
  return node.kind === 'document' || mediaType === 'text/markdown' || name.endsWith('.md') || name.endsWith('.markdown')
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

function directoryIcon(): string {
  return '<svg class="panel-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3.5 5.25h4l1.35 1.5h7.65v8H3.5v-9.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>'
}

function outlineIcon(): string {
  return '<svg class="panel-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 5.5h10M5 10h7.5M5 14.5h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
}

function chevronIcon(): string {
  return '<svg class="chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m5.75 6.25 2.25 2.5 2.25-2.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>'
}

function folderIcon(): string {
  return '<svg class="tree-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3.5 5.5h4l1.25 1.4h7.75v7.6h-13v-9Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>'
}

function fileIcon(): string {
  return '<svg class="tree-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5.25 3.5h6l3.5 3.5v9.5h-9.5v-13Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M11.25 3.75V7h3.25" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>'
}

function downloadIcon(): string {
  return '<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M9 2.75v8.5m0 0 3-3m-3 3-3-3M3.5 14.75h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
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
:root{color-scheme:light dark;--page:#eef0f2;--shell:rgba(250,251,252,.84);--surface:rgba(255,255,255,.42);--panel:rgba(239,242,244,.6);--raised:rgba(255,255,255,.78);--line:rgba(25,31,36,.11);--line-strong:rgba(25,31,36,.24);--text:#202428;--muted:#727b82;--soft:#8b9399;--accent:#4f5961;--code:#f1f3f4;--shadow:0 18px 58px rgba(24,30,35,.11);--radius:20px;--font-ui:Inter,"SF Pro Text","PingFang SC","Microsoft YaHei",system-ui,sans-serif;--font-reading:"Source Han Sans SC","Noto Sans CJK SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif;--font-mono:"SFMono-Regular",Consolas,"Liberation Mono",monospace}
*{box-sizing:border-box}html{min-width:0;background:var(--page);color:var(--text);font-family:var(--font-ui);scroll-behavior:smooth}body{min-width:0;min-height:100dvh;margin:0;padding:clamp(10px,2vw,28px);background:radial-gradient(circle at 14% 4%,rgba(255,255,255,.92),transparent 34%),var(--page)}button,input,select,textarea,a,summary{font:inherit}.share-shell{width:min(1680px,100%);min-height:calc(100dvh - clamp(20px,4vw,56px));margin:0 auto;overflow:hidden;border:1px solid var(--line);border-radius:var(--radius);background:var(--shell);box-shadow:var(--shadow);backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px)}.share-header{min-height:96px;display:flex;align-items:center;justify-content:space-between;gap:24px;border-bottom:1px solid var(--line);padding:19px clamp(18px,2vw,30px)}.share-title{min-width:0}.eyebrow{display:block;color:var(--muted);font:650 10px/1.2 var(--font-mono);letter-spacing:.12em}.share-header h1{margin:7px 0 0;overflow-wrap:anywhere;font-size:clamp(20px,2.3vw,30px);line-height:1.2;letter-spacing:-.025em}.share-header p{margin:5px 0 0;color:var(--muted);font-size:12px}.readonly{flex:none;border:1px solid var(--line);border-radius:999px;padding:7px 11px;background:var(--raised);color:#626a70;font-size:11px}.share-workspace{min-height:calc(100dvh - 210px);display:grid;grid-template-columns:auto minmax(0,1fr) auto}.share-workspace.is-single{grid-template-columns:minmax(0,1fr)}.share-panel{min-width:0;width:52px;background:var(--panel)}.share-panel[open]{width:clamp(220px,19vw,300px)}.directory-panel{border-right:1px solid var(--line)}.outline-panel{border-left:1px solid var(--line)}.panel-toggle{min-height:50px;display:flex;align-items:center;gap:8px;padding:0 14px;color:var(--muted);cursor:pointer;list-style:none;user-select:none;touch-action:manipulation}.panel-toggle::-webkit-details-marker,.tree-item::-webkit-details-marker{display:none}.panel-toggle::marker,.tree-item::marker{content:""}.panel-toggle:hover{background:rgba(255,255,255,.32);color:var(--text)}.panel-toggle:focus-visible,.tree-item:focus-visible,.share-outline a:focus-visible,.download:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.panel-icon{width:20px;height:20px;flex:none}.panel-label{min-width:0;overflow:hidden;font-size:12px;font-weight:650;white-space:nowrap}.panel-count{min-width:19px;margin-left:auto;border-radius:999px;padding:2px 5px;background:rgba(34,40,45,.07);font:600 10px/1.35 var(--font-mono);text-align:center}.chevron{width:16px;height:16px;flex:none;transition:transform .16s ease}.share-panel[open]>.panel-toggle>.chevron,.tree-folder[open]>.tree-item>.chevron{transform:rotate(180deg)}.share-panel:not([open])>.panel-toggle{justify-content:center;padding-inline:0}.share-panel:not([open]) .panel-label,.share-panel:not([open]) .panel-count,.share-panel:not([open])>.panel-toggle>.chevron{display:none}.share-tree,.share-outline{max-height:calc(100dvh - 260px);overflow:auto;padding:5px 9px 14px;scrollbar-width:thin;scrollbar-color:rgba(90,99,106,.35) transparent}.tree-root,.tree-item{min-width:0;min-height:38px;display:flex;align-items:center;gap:8px;border:0;border-radius:9px;padding:7px 9px;color:#4d555b;font-size:12px;text-decoration:none;cursor:pointer}.tree-root{margin-bottom:5px;color:var(--text);font-weight:650}.tree-item{padding-left:calc(9px + var(--depth)*14px)}.tree-item span,.tree-root span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tree-icon{width:18px;height:18px;flex:none;color:#7e878e}.tree-folder>.tree-item>.chevron{margin-left:auto}.tree-folder:not([open])>.tree-children{display:none}.tree-root:hover,.tree-item:hover{background:rgba(255,255,255,.66);color:var(--text)}.tree-item.is-active{background:var(--raised);color:var(--text);box-shadow:inset 2px 0 0 var(--accent),0 1px 5px rgba(25,31,36,.07)}.share-outline{padding-top:4px}.share-outline a{min-height:34px;display:flex;align-items:center;border-radius:8px;padding:6px 8px 6px calc(8px + min(var(--level),3)*12px);overflow:hidden;color:#566068;font-size:11px;line-height:1.4;text-decoration:none;text-overflow:ellipsis;white-space:nowrap}.share-outline a:hover{background:rgba(255,255,255,.66);color:var(--text)}.outline-empty{margin:8px;padding:12px;border:1px dashed var(--line);border-radius:9px;color:var(--muted);font-size:11px;line-height:1.5}.share-content{min-width:0;display:grid;align-content:start;grid-template-rows:auto minmax(0,1fr);background:var(--surface)}.content-header{min-height:72px;display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:1px solid var(--line);padding:13px clamp(16px,2.5vw,34px)}.content-title{min-width:0}.content-header .content-title>span{display:block;max-width:min(70vw,900px);overflow:hidden;color:var(--muted);font-size:10px;text-overflow:ellipsis;white-space:nowrap}.content-header h2{margin:5px 0 0;overflow-wrap:anywhere;font-size:18px;letter-spacing:-.015em}.download{min-height:44px;display:inline-flex;align-items:center;justify-content:center;gap:7px;flex:none;border:1px solid var(--line);border-radius:10px;padding:8px 13px;background:var(--raised);color:#30363b;font-size:12px;font-weight:620;text-decoration:none;touch-action:manipulation}.download svg{width:17px;height:17px}.download:hover{border-color:var(--line-strong);background:#fff}.download.primary{margin-top:12px;background:#30363b;color:#fff}.document{min-width:0;padding:clamp(26px,4vw,66px) clamp(18px,5vw,84px) 72px}.plain-text,.markdown-body{width:min(100%,980px);margin:0 auto;color:#30363b;overflow-wrap:anywhere}.plain-text{font:14px/1.78 var(--font-mono);white-space:pre-wrap}.markdown-body{font:15px/1.78 var(--font-reading)}.markdown-body>*:first-child{margin-top:0}.markdown-body>*:last-child{margin-bottom:0}.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4,.markdown-body h5,.markdown-body h6{position:relative;margin:1.65em 0 .65em;color:var(--text);font-family:var(--font-ui);line-height:1.35;letter-spacing:-.018em;scroll-margin-top:22px}.markdown-body h1{font-size:2em}.markdown-body h2{border-bottom:1px solid var(--line);padding-bottom:.34em;font-size:1.55em}.markdown-body h3{font-size:1.28em}.markdown-body h4{font-size:1.1em}.markdown-body h5,.markdown-body h6{font-size:1em}.heading-anchor{margin-left:.45em;color:var(--soft);font-weight:450;text-decoration:none;opacity:0}.markdown-body :is(h1,h2,h3,h4,h5,h6):hover .heading-anchor,.heading-anchor:focus-visible{opacity:1}.markdown-body p{margin:.85em 0}.markdown-body a{color:#3f647b;text-decoration-color:rgba(63,100,123,.35);text-underline-offset:3px}.markdown-body a:hover{text-decoration-color:currentColor}.markdown-body ul,.markdown-body ol{margin:.75em 0;padding-left:1.65em}.markdown-body li+li{margin-top:.25em}.markdown-body blockquote{margin:1.15em 0;border-left:3px solid #9aa2a8;padding:.15em 1em;color:#5f686f}.markdown-body code{border:1px solid var(--line);border-radius:5px;padding:.12em .35em;background:var(--code);font:13px/1.5 var(--font-mono)}.markdown-body pre{max-width:100%;overflow:auto;border:1px solid var(--line);border-radius:12px;padding:16px;background:var(--code);scrollbar-width:thin}.markdown-body pre code{border:0;padding:0;background:transparent;white-space:pre}.markdown-body hr{height:1px;margin:2em 0;border:0;background:var(--line)}.markdown-body table{width:100%;display:block;margin:1.2em 0;overflow-x:auto;border-collapse:collapse;scrollbar-width:thin}.markdown-body th,.markdown-body td{min-width:110px;border:1px solid var(--line);padding:8px 11px;text-align:left}.markdown-body th{background:rgba(85,94,101,.06);font-weight:650}.markdown-body img{max-width:100%;height:auto;display:block;margin:1.4em auto;border-radius:12px}.task-box{width:14px;height:14px;display:inline-grid;place-items:center;margin:0 7px 0 -1.4em;border:1px solid #899198;border-radius:4px;vertical-align:-2px}.task-box.is-checked:after{width:7px;height:4px;border:solid currentColor;border-width:0 0 1.5px 1.5px;content:"";transform:translateY(-1px) rotate(-45deg)}.unsafe-link,.image-fallback{color:var(--muted)}.image-stage{min-height:0;display:grid;place-items:center;padding:24px}.image-stage img{max-width:100%;max-height:72dvh;border-radius:12px;box-shadow:0 10px 34px rgba(25,31,36,.12)}.empty{min-height:420px;display:grid;place-content:center;justify-items:center;padding:32px;color:var(--muted);text-align:center}.empty h2{margin:14px 0 0;color:#30363b;font-size:17px}.empty p{margin:6px 0 0;font-size:12px}.empty-mark,.file-large{width:54px;height:39px;border:1.5px solid #939ba1;border-radius:7px;background:rgba(255,255,255,.55)}.file-large{width:40px;height:50px}.notice{margin:10px 7px;border-left:2px solid #7e878e;padding:6px 9px;color:var(--muted);font-size:11px;line-height:1.5}.content-notice{margin:16px clamp(16px,3vw,32px) 0}.share-footer{min-height:48px;display:flex;align-items:center;justify-content:space-between;gap:16px;border-top:1px solid var(--line);padding:10px 18px;color:var(--muted);font-size:10px}
body{overflow:hidden}.share-shell{height:calc(100dvh - clamp(20px,4vw,56px));min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr) auto}.share-workspace{min-height:0;overflow:hidden}.share-panel{height:100%;overflow:hidden}.share-panel[open]{display:grid;grid-template-rows:auto minmax(0,1fr)}.share-tree,.share-outline{min-height:0;max-height:none}.share-content{min-height:0;display:block;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:rgba(90,99,106,.35) transparent}.content-header{position:sticky;z-index:3;top:0;background:rgba(250,251,252,.9);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
@media(max-width:860px){body{padding:0}.share-shell{height:100dvh;min-height:0;border:0;border-radius:0}.share-header{min-height:86px;padding:15px 16px}.readonly{display:none}.share-workspace,.share-workspace.is-single{min-height:0;display:flex;overflow:hidden;flex-direction:column}.share-panel,.share-panel[open]{width:100%;height:auto;display:block;flex:none;border:0;border-bottom:1px solid var(--line)}.directory-panel{order:1}.outline-panel{order:2}.share-content{order:3;min-height:0;flex:1;overflow:auto}.share-panel:not([open])>.panel-toggle{justify-content:flex-start;padding-inline:14px}.share-panel:not([open]) .panel-label,.share-panel:not([open]) .panel-count,.share-panel:not([open])>.panel-toggle>.chevron{display:inline-flex}.share-panel:not([open])>.panel-toggle>.chevron{margin-left:auto}.share-panel[open]>.panel-toggle>.chevron{margin-left:0}.share-tree,.share-outline{max-height:min(30dvh,240px)}.content-header{padding-inline:16px}.content-header .content-title>span{max-width:62vw}.document{padding:28px 18px 52px}.markdown-body{font-size:16px}.markdown-body h1{font-size:1.72em}.markdown-body h2{font-size:1.42em}.download span{display:none}.share-footer{align-items:flex-start;flex-direction:column;gap:3px;padding:11px 16px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.chevron{transition:none}}
@media(prefers-color-scheme:dark){:root{--page:#17191b;--shell:rgba(31,34,37,.9);--surface:rgba(255,255,255,.018);--panel:rgba(15,17,18,.27);--raised:rgba(255,255,255,.065);--line:rgba(255,255,255,.1);--line-strong:rgba(255,255,255,.3);--text:#eef0f2;--muted:#9ba1a6;--soft:#777f85;--accent:#b8bec2;--code:rgba(9,11,12,.38);--shadow:0 18px 58px rgba(0,0,0,.36)}body{background:radial-gradient(circle at 14% 4%,rgba(255,255,255,.055),transparent 34%),var(--page)}.content-header{background:rgba(31,34,37,.9)}.readonly,.download{color:#d9dcde}.panel-toggle:hover,.tree-root:hover,.tree-item:hover,.share-outline a:hover{background:rgba(255,255,255,.065)}.panel-count{background:rgba(255,255,255,.07)}.tree-root{color:var(--text)}.tree-item,.share-outline a{color:#b5babd}.tree-icon{color:#858d93}.tree-item.is-active{color:#f1f2f3;box-shadow:inset 2px 0 0 var(--accent),0 1px 7px rgba(0,0,0,.2)}.download:hover{background:rgba(255,255,255,.1)}.download.primary{background:#e3e6e8;color:#202326}.plain-text,.markdown-body{color:#d9dcde}.markdown-body a{color:#91b9cf}.markdown-body blockquote{color:#aeb4b8}.markdown-body th{background:rgba(255,255,255,.045)}.empty h2{color:#e4e7e9}.empty-mark,.file-large{border-color:#777f85;background:rgba(255,255,255,.04)}}
`
