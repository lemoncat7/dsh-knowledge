import assert from 'node:assert/strict'

/** Exercise real scroll clipping, rather than merely checking z-index or screenshots at the top. */
export async function assertRecallScrollLayout(page) {
  const result = await page.evaluate(async () => {
    const content = document.querySelector('.app-shell[data-view="recall"] .page')
    const main = content.closest('.main'), header = main.querySelector('.topbar')
    const initialTop = header.getBoundingClientRect().top
    content.scrollTop = 500
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const rect = content.getBoundingClientRect(), title = header.getBoundingClientRect()
    const paintedBehindTitle = document.elementsFromPoint(rect.left + rect.width / 2, title.bottom - 4)
      .some(node => node.closest('.recall-workspace'))
    const result = {
      scrolled: content.scrollTop, mainScroll: main.scrollTop, windowScroll: scrollY,
      headerMoved: Math.abs(title.top - initialTop), overlaps: rect.top < title.bottom - 1,
      clipped: getComputedStyle(content).contain.includes('paint'), paintedBehindTitle,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    }
    const target = content.querySelector('.recall-title')
    // Re-focus as keyboard navigation would; focusing an already-active node
    // after a programmatic scroll intentionally does not scroll it into view.
    target.blur()
    target.focus()
    await new Promise(resolve => requestAnimationFrame(resolve))
    const focused = target.getBoundingClientRect()
    result.focusHidden = focused.top < title.bottom - 1 || focused.bottom > rect.bottom + 1
    content.scrollTop = 0
    return result
  })
  assert.ok(result.scrolled > 100, 'Recall content must own its scroll container')
  assert.equal(result.mainScroll, 0, 'Outer main must not scroll content under header')
  assert.equal(result.windowScroll, 0)
  assert.ok(result.headerMoved < 1)
  assert.equal(result.overlaps, false)
  assert.equal(result.clipped, true, 'Transparent header needs a separate clipped content region')
  assert.equal(result.paintedBehindTitle, false)
  assert.equal(result.horizontalOverflow, false)
  assert.equal(result.focusHidden, false, JSON.stringify(result))
  return result
}
