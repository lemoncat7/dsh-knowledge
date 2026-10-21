import assert from 'node:assert/strict'

export async function assertRecallRowHover(page) {
  const row = page.locator('[data-recall-id]').first()
  await page.evaluate(() => document.activeElement?.blur())
  await page.mouse.move(0, 0)
  await row.scrollIntoViewIfNeeded()
  const normal = await row.evaluate(node => ({ background: getComputedStyle(node).backgroundColor, height: node.getBoundingClientRect().height }))
  await row.hover()
  const inspect = () => row.evaluate(node => {
    const style = getComputedStyle(node)
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d')
    const rgba = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data] }
    const base = rgba(style.backgroundColor)
    // Composite translucent surfaces over the default palette for contrast checks.
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg')
    context.fillRect(0, 0, 1, 1)
    const layers = []; for (let current = node; current; current = current.parentElement) layers.unshift(current)
    for (const layer of layers) { context.fillStyle = getComputedStyle(layer).backgroundColor; context.fillRect(0, 0, 1, 1) }
    const background = [...context.getImageData(0, 0, 1, 1).data]
    const luminance = channels => channels.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
    const contrasts = [node.querySelector('.recall-title'), node.querySelector('small')].map(target => {
      const a = luminance(rgba(getComputedStyle(target).color)), b = luminance(background)
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
    })
    return { baseAlpha: base[3], background: style.backgroundColor, image: style.backgroundImage, contrasts, height: node.getBoundingClientRect().height, hover: node.matches(':hover'), pointer: matchMedia('(hover: hover)').matches, color: style.getPropertyValue('--text') }
  })
  const hovered = await inspect()
  assert.ok(hovered.baseAlpha >= 20 && hovered.baseAlpha <= 40, 'Hover must be a subtle theme-relative wash, not an opaque block: ' + JSON.stringify(hovered))
  assert.equal(hovered.image, 'none')
  assert.notEqual(hovered.background, normal.background)
  assert.equal(hovered.height, normal.height)
  assert.ok(hovered.contrasts.every(value => value >= 4.5), JSON.stringify(hovered))
  await page.mouse.move(0, 0)
  await page.keyboard.press('Tab')
  await row.locator('.recall-title').focus()
  const focused = await inspect()
  assert.equal(focused.background, normal.background, 'Focus must not latch the row background')
  const outline = await row.locator('.recall-title').evaluate(node => ({ visible: node.matches(':focus-visible'), style: getComputedStyle(node).outlineStyle, width: parseFloat(getComputedStyle(node).outlineWidth) }))
  assert.ok(outline.visible && outline.style !== 'none' && outline.width > 0, 'Keyboard focus must stay visible on the control')
  await row.locator('.recall-title').evaluate(node => node.blur())
  assert.equal(await row.evaluate(node => getComputedStyle(node).backgroundColor), normal.background)
  // Real reproduction: mouse-open settings, focus a field, then return via Cancel.
  await row.getByRole('button', { name: /召回设置/ }).click()
  await page.getByRole('textbox', { name: '调整原因' }).focus()
  await page.locator('.dialog').getByRole('button', { name: '取消', exact: true }).click()
  await page.mouse.move(0, 0)
  await page.locator('.dialog-backdrop').waitFor({ state: 'detached' })
  assert.equal(await row.evaluate(node => getComputedStyle(node).backgroundColor), normal.background, 'Closing settings must not leave the row highlighted')
  return hovered
}
