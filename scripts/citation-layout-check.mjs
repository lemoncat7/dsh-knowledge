import assert from 'node:assert/strict'

export async function assertCitationLayout(page) {
  const result = await page.evaluate(async () => {
    const content = document.querySelector('.app-shell[data-citation="true"] .note-editor-scroll')
    const main = content.closest('.main'), header = main.querySelector('.topbar')
    const top = header.getBoundingClientRect().top
    const saved = content.scrollTop
    content.scrollTop = content.scrollHeight
    main.scrollTop = main.scrollHeight
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const rect = content.getBoundingClientRect(), title = header.getBoundingClientRect()
    const result = {
      mainScroll: main.scrollTop, windowScroll: scrollY,
      moved: Math.abs(title.top - top), overlaps: rect.top < title.bottom - 1,
      clipped: getComputedStyle(content).contain.includes('paint'),
      paintedBehindTitle: document.elementsFromPoint(rect.left + rect.width / 2, title.bottom - 4).some(n => n.closest('.note-paper')),
      overflow: document.documentElement.scrollWidth > innerWidth,
    }
    content.scrollTop = saved
    return result
  })
  assert.equal(result.mainScroll, 0, 'Source must not scroll underneath its header')
  assert.equal(result.windowScroll, 0)
  assert.ok(result.moved < 1)
  assert.equal(result.overlaps, false)
  assert.equal(result.clipped, true)
  assert.equal(result.paintedBehindTitle, false)
  assert.equal(result.overflow, false)
}
