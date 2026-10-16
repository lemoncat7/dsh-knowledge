/** Reuse material surfaces and navigation; only the route body is replaced.
 * No caching of editors, credentials or business data lives in this renderer.
 */
function syncAttributes(current, next) {
  for (const attribute of [...current.attributes]) {
    if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name)
  }
  for (const attribute of next.attributes) {
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value)
  }
}

export function isPendingShell(shell, view) {
  return shell?.dataset.loading === 'true' && shell.dataset.view === view
}

export function commitWorkspaceShell(app, next) {
  const current = app.querySelector('.app-shell')
  if (!current) { app.replaceChildren(next); return next }
  const wasLoading = current.dataset.loading === 'true'
  syncAttributes(current, next)
  const sidebar = current.querySelector('.sidebar'), nextSidebar = next.querySelector('.sidebar')
  const buttons = [...sidebar.querySelectorAll('[data-nav-view]')]
  const nextButtons = [...nextSidebar.querySelectorAll('[data-nav-view]')]
  if (buttons.map(n => n.dataset.navView).join() !== nextButtons.map(n => n.dataset.navView).join()) {
    sidebar.replaceChildren(...nextSidebar.childNodes)
  } else {
    for (const [index, button] of buttons.entries()) {
      const replacement = nextButtons[index]
      syncAttributes(button, replacement)
      if (button.textContent !== replacement.textContent) button.replaceChildren(...replacement.childNodes)
    }
    const footer = sidebar.querySelector('.sidebar-footer'), nextFooter = nextSidebar.querySelector('.sidebar-footer')
    if (footer.textContent !== nextFooter.textContent) footer.replaceChildren(...nextFooter.childNodes)
  }
  for (const selector of ['.app-sidebar-resizer', '.app-sidebar-scrim', '.main', '.page', '.view-stage']) {
    syncAttributes(current.querySelector(selector), next.querySelector(selector))
  }
  // The toolbar actions may close over the current workspace; replace their
  // controls, not the translucent surface underneath them.
  current.querySelector('.topbar').replaceChildren(...next.querySelector('.topbar').childNodes)
  const stage = current.querySelector('.view-stage')
  stage.getAnimations?.().forEach(animation => animation.cancel())
  stage.replaceChildren(...next.querySelector('.view-stage').childNodes)
  if (wasLoading && next.dataset.loading === 'false' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    stage.animate?.([{ opacity: .9 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' })
  }
  return current
}
