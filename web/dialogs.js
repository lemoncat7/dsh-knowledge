/** Shared modal lifecycle, keyboard handling and dirty-form protection. */
export function createDialogPresenter({ element, actionButton, interfaceIcon, showToast, friendlyError }) {
  let sequence = 0
  const stack = []
  function openConfirm({ title, message, confirmLabel, danger, onConfirm }) {
    return openModal({ title, body: element('p', {}, message), primaryLabel: confirmLabel, primaryVariant: danger ? 'danger' : 'primary', onPrimary: async () => { await onConfirm(); return true } })
  }

  function openSheet(options) {
    return openModal({ ...options, presentation: 'sheet' })
  }

  function openModal({ title, description = '', body, primaryLabel, primaryVariant = 'primary', onPrimary, cancelLabel = '取消', presentation = 'modal', className = '', onClose }) {
    const previouslyFocused = document.activeElement
    const isSheet = presentation === 'sheet'
    const titleId = `knowledge-dialog-title-${++sequence}`
    const backdrop = element('div', { class: `dialog-backdrop${isSheet ? ' sheet-backdrop' : ''}` })
    const dialog = element('section', { class: `dialog${isSheet ? ' sheet' : ''} ${primaryLabel ? '' : 'narrow'} ${className}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' })
    let busy = false
    let formDirty = false
    let closed = false
    const close = (explicit = false) => {
      if (busy || closed) return
      if (!explicit && formDirty) {
        showToast('表单有未保存的修改，请先保存，或使用“取消”放弃修改。', 'error')
        return
      }
      document.removeEventListener('keydown', onKeyDown)
      closed = true
      stack.splice(stack.indexOf(dialog), 1)
      backdrop.remove()
      onClose?.()
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
    const closeButton = actionButton(interfaceIcon('close'), () => close(), 'ghost', { 'aria-label': '关闭对话框' })
    const cancel = actionButton(cancelLabel, () => close(true))
    const primary = primaryLabel ? actionButton(primaryLabel, async () => {
      if (busy) return
      busy = true
      primary.disabled = true
      cancel.disabled = true
      const original = primary.textContent
      primary.textContent = '正在处理…'
      try {
        const shouldClose = await onPrimary()
        busy = false
        if (shouldClose !== false) close(true)
        else { primary.disabled = false; cancel.disabled = false; primary.textContent = original }
      } catch (error) {
        busy = false
        primary.disabled = false
        cancel.disabled = false
        primary.textContent = original
        showToast(friendlyError(error), 'error')
      }
    }, primaryVariant) : null
    const onKeyDown = (event) => {
      if (stack.at(-1) !== dialog || event.defaultPrevented) return
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key === 'Tab') trapFocus(event, dialog)
    }
    dialog.append(
      element('header', { class: 'dialog-header' }, element('div', {}, element('h2', { id: titleId }, title), description ? element('p', {}, description) : null), closeButton),
      element('div', { class: 'dialog-body' }, body),
      element('footer', { class: 'dialog-footer' }, cancel, primary),
    )
    backdrop.append(dialog)
    backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) close() })
    if (body.matches?.('form') || body.querySelector?.('form')) {
      body.addEventListener('input', () => { formDirty = true })
      body.addEventListener('change', () => { formDirty = true })
    }
    document.body.append(backdrop)
    stack.push(dialog)
    document.addEventListener('keydown', onKeyDown)
    window.setTimeout(() => { if (!closed && stack.at(-1) === dialog) (focusableElements(dialog)[0] || dialog).focus() }, 0)
    return { close, dialog }
  }

  function trapFocus(event, container) {
    const focusable = focusableElements(container)
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable.at(-1)
    if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) { event.preventDefault(); first.focus() }
  }

  function focusableElements(container) {
    return [...container.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
      .filter(node => !node.disabled && node.tabIndex >= 0 && !node.closest('[hidden], [inert], [aria-hidden="true"]') && node.getClientRects().length > 0)
  }
  return { openConfirm, openSheet, openModal }
}
