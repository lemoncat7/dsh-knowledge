/** Shared modal lifecycle, keyboard handling and dirty-form protection. */
const discardUrl = new URL('./discard-confirmation.js', import.meta.url)
discardUrl.search = new URL(import.meta.url).search
const { createDiscardConfirmation } = await import(discardUrl.href)

export function createDialogPresenter({ element, actionButton, interfaceIcon, showToast, friendlyError, createDialogSteps }) {
  let sequence = 0
  const stack = []
  function openConfirm({ title, message, confirmLabel, danger, onConfirm }) {
    return openModal({ title, body: element('p', {}, message), primaryLabel: confirmLabel, primaryVariant: danger ? 'danger' : 'primary', onPrimary: async () => { await onConfirm(); return true } })
  }

  function openSheet(options) {
    // Compatibility alias for existing callers; every dialog now uses one centered shell.
    return openModal(options)
  }

  function openModal({ title, description = '', body, primaryLabel, primaryVariant = 'primary', onPrimary, cancelLabel = '取消', className = '', onClose, steps }) {
    const previouslyFocused = document.activeElement
    const titleId = `knowledge-dialog-title-${++sequence}`
    const backdrop = element('div', { class: 'dialog-backdrop' })
    const dialog = element('section', { class: `dialog ${primaryLabel ? '' : 'narrow'} ${className}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' })
    let busy = false
    let formDirty = false
    let closed = false
    let navigation
    const discard = createDiscardConfirmation({ owner: dialog, onDiscard: () => close(true), canDiscard: () => !busy && !closed })
    const feedback = element('p', { class: 'dialog-feedback', role: 'alert', hidden: true })
    const showError = message => { feedback.textContent = message; feedback.hidden = false }
    const close = (explicit = false) => {
      if (busy || closed) return
      if (!explicit && formDirty) {
        discard.request()
        return
      }
      document.removeEventListener('keydown', onKeyDown)
      closed = true
      discard.dispose()
      stack.splice(stack.indexOf(dialog), 1)
      navigation?.dispose()
      // Release focus/listeners immediately. Animation is decorative, never a save dependency.
      backdrop.inert = true
      backdrop.classList.add('is-closing')
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) backdrop.remove()
      else window.setTimeout(() => backdrop.remove(), 160)
      onClose?.()
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected && (!stack.length || stack.at(-1).contains(previouslyFocused))) previouslyFocused.focus()
    }
    const closeButton = actionButton(interfaceIcon('close'), () => close(), 'ghost', { 'aria-label': '关闭对话框' })
    const cancel = actionButton(cancelLabel, () => close())
    const primary = primaryLabel ? actionButton(primaryLabel, async () => {
      if (busy || closed) return
      feedback.hidden = true
      if (navigation && !navigation.isLast) { navigation.next(); return }
      if (navigation && !navigation.validate()) return
      busy = true
      primary.disabled = true
      cancel.disabled = true
      closeButton.disabled = true
      navigation?.setBusy(true)
      dialog.setAttribute('aria-busy', 'true')
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
        showError(friendlyError(error))
      } finally {
        closeButton.disabled = false
        navigation?.setBusy(false)
        dialog.removeAttribute('aria-busy')
      }
    }, primaryVariant) : null
    if (steps?.length && createDialogSteps && primary) {
      dialog.classList.add('has-steps')
      // Validate/reveal the owning step before native validation attempts to focus a hidden field.
      if (body.matches('form')) body.noValidate = true
      navigation = createDialogSteps({ steps, element, actionButton, interfaceIcon,
        onChange: last => { primary.textContent = last ? primaryLabel : '继续' },
      })
      body.addEventListener('submit', event => { event.preventDefault(); primary.click() })
    }
    const onKeyDown = (event) => {
      if (stack.at(-1) !== dialog || event.defaultPrevented || discard.isOpen) return
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key === 'Tab') trapFocus(event, dialog)
    }
    dialog.append(
      element('header', { class: 'dialog-header' }, element('div', {}, element('h2', { id: titleId }, title), description ? element('p', {}, description) : null), closeButton),
      ...(navigation ? [navigation.track] : []),
      element('div', { class: 'dialog-body' }, body),
      feedback,
      element('footer', { class: 'dialog-footer' }, navigation?.status, navigation?.back, cancel, primary),
    )
    backdrop.append(dialog)
    let backdropPointer = null
    backdrop.addEventListener('pointerdown', event => { backdropPointer = event.button === 0 && event.target === backdrop ? event.pointerId : null })
    backdrop.addEventListener('pointerup', event => {
      const dismiss = backdropPointer === event.pointerId && event.target === backdrop && stack.at(-1) === dialog
      backdropPointer = null
      if (dismiss) close()
    })
    backdrop.addEventListener('pointercancel', () => { backdropPointer = null })
    const markDirty = event => {
      if (event.target.matches?.('input:not([type="search"]), select, textarea, [contenteditable="true"]')) formDirty = true
    }
    body.addEventListener('input', markDirty)
    body.addEventListener('change', markDirty)
    document.body.append(backdrop)
    stack.push(dialog)
    document.addEventListener('keydown', onKeyDown)
    window.setTimeout(() => {
      if (!closed && stack.at(-1) === dialog && !dialog.contains(document.activeElement)) (focusableElements(dialog.querySelector('.dialog-body'))[0] || dialog).focus()
    }, 0)
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
