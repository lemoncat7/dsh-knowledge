/** Validate a historical source before opening the existing document workspace. */
export async function resolveCitation(raw, signal) {
  let ref
  try { ref = JSON.parse(raw) } catch { throw Error('来源引用格式无效，请从原回答重新打开。') }
  const response = await fetch('/knowledge-control/v1/activity/citation?' + new URLSearchParams({ citation: raw, sessionId: ref?.sessionId || '' }), {
    signal, headers: { 'x-dsh-knowledge-client': 'conversation-web' },
  })
  const data = await response.json()
  if (!response.ok) throw Error(data.error || '无法打开来源文档')
  return ref
}

export function highlightCitation(preview, ref, position = true) {
  const blocks = [...preview.querySelectorAll('[data-source-start]')].filter(block =>
    Number(block.dataset.sourceStart) <= ref.endLine && Number(block.dataset.sourceEnd) >= ref.startLine)
  for (const block of blocks) block.classList.add('is-citation-target')
  const target = blocks[0]
  if (!target) return
  target.tabIndex = -1
  target.setAttribute('aria-label', `引用所在段落，第 ${ref.startLine}–${ref.endLine} 行`)
  if (!position) return
  requestAnimationFrame(() => {
    if (!preview.isConnected) return
    const scroller = preview.closest('.note-editor-scroll')
    if (!scroller) return
    scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24
    target.focus({ preventScroll: true })
  })
}
