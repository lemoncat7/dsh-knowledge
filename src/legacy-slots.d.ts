// Legacy host contracts for the pre-0.1.5 fallback branches.
// SlotMap and ILayout sit on official declaration-merging surfaces (ui-slots:
// "Owners extend via declaration merging"; ui-layout: "the ctx.layout face
// consumers and test fakes type against"). DSH 0.1.7 dropped these members,
// but the legacy branches still call them, and the 0.1.7 runtime never takes
// those branches — supportsDockedPanels probes layout.selectPanel first.
// This bridge exists only so the pinned 0.1.7-rc.2 SDK type-checks them.

import '@deepseek-ai/dsh-client-ui-slots'
import '@deepseek-ai/dsh-client-ui-layout/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Pre-0.1.5 conversation seat (legacy host fallback). */
    conversation: { kind: 'single'; scope: 'session-maybe' }
    /** Pre-0.1.5 right details column (legacy host fallback). */
    details: { kind: 'single'; scope: 'session' }
  }
}

declare module '@deepseek-ai/dsh-client-ui-layout/client' {
  interface ILayout {
    /** Pre-0.1.5 details column controls (legacy host fallback). */
    openDetails(): void
    /** Pre-0.1.5 details column controls (legacy host fallback). */
    closeDetails(): void
  }
}
