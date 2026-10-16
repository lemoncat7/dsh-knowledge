/** Shared by DOM forms and the React worklog. Native top layer also covers native parent dialogs. */
export function createDiscardConfirmation({ owner, onDiscard, canDiscard = () => true }) {
  let prompt
  let finish
  return {
    get isOpen() { return Boolean(prompt) },
    request() {
      if (prompt || !owner.isConnected || !canDiscard()) return
      const previous = document.activeElement
      const id = `knowledge-discard-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const dialog = document.createElement('dialog')
      dialog.className = 'knowledge-discard-dialog'
      dialog.setAttribute('role', 'alertdialog')
      dialog.setAttribute('aria-labelledby', `${id}-title`)
      dialog.setAttribute('aria-describedby', `${id}-description`)
      const title = document.createElement('h2')
      title.id = `${id}-title`
      title.textContent = '放弃未保存的修改？'
      const description = document.createElement('p')
      description.id = `${id}-description`
      description.textContent = '关闭后，本次未保存的修改将丢失。你可以继续编辑，或放弃修改并关闭。'
      const footer = document.createElement('footer')
      const keep = document.createElement('button')
      keep.type = 'button'
      keep.textContent = '继续编辑'
      keep.autofocus = true
      const discard = document.createElement('button')
      discard.type = 'button'
      discard.className = 'is-danger'
      discard.textContent = '放弃修改'
      footer.append(keep, discard)
      dialog.append(title, description, footer)
      let pointer = null
      let settled = false
      const settle = (confirmed = false, restore = true) => {
        if (settled || (confirmed && !canDiscard())) return
        settled = true
        prompt = undefined
        dialog.close()
        dialog.remove()
        if (restore && previous?.isConnected) previous.focus({ preventScroll: true })
        if (confirmed && owner.isConnected) onDiscard()
      }
      finish = settle
      keep.addEventListener('click', () => settle(false))
      discard.addEventListener('click', () => settle(true))
      dialog.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); settle(false) })
      dialog.addEventListener('close', () => settle(false))
      dialog.addEventListener('keydown', event => {
        // Do not let the underlying DOM modal interpret the same Escape/Tab again.
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); settle(false) }
        if (event.key === 'Tab') {
          event.preventDefault(); event.stopPropagation()
          ;(document.activeElement === keep ? discard : keep).focus()
        }
      })
      const outside = event => {
        if (event.target !== dialog) return false
        const box = dialog.getBoundingClientRect()
        return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom
      }
      dialog.addEventListener('pointerdown', event => { pointer = event.button === 0 && outside(event) ? event.pointerId : null })
      dialog.addEventListener('pointerup', event => {
        const dismiss = pointer === event.pointerId && outside(event)
        pointer = null
        if (dismiss) settle(false)
      })
      dialog.addEventListener('pointercancel', () => { pointer = null })
      prompt = dialog
      document.body.append(dialog)
      dialog.showModal()
      keep.focus({ preventScroll: true })
    },
    dispose() { if (prompt) finish(false, false) },
  }
}
