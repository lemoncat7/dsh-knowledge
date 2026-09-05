# UI ownership and regression boundaries

The plugin owns its component appearance. DSH provides placement and light/dark
mode, not palette values from the active decorative theme. No private shared UI
package or DSH source patch is required.

## Responsibilities

- `src/design-tokens.ts`: canonical light/dark palette and font families. The
  build generates `web/design-tokens.css` from this source; do not edit the
  generated asset. Host client roots receive scoped copies of the same tokens.
- `src/theme-bridge.ts` and `web/host-theme.js`: versioned, validated iframe
  theme transport. Only mode and allowlisted plugin tokens cross the boundary.
- `src/client.css` / `src/knowledge-activity.css`: host-side launcher, activity
  reader and conversation status. Do not style host parents or sibling slots.
- `web/styles.css`: management-workspace layout and components. Embedded canvas
  stays transparent; overlaid menus, mobile navigation and outline are solid
  enough to prevent text from showing through.
- `web/ui-primitives.js`: DOM primitives, icons, actions and notifications.
- `web/dialogs.js`: dialog lifetime, dirty-form protection and keyboard focus.
- `web/select-control.js`: plugin-owned select appearance and listbox behavior;
  native value, validation, reset and change semantics remain available to forms.
- `web/model-catalog.js`: coalesced discovery requests and expiring success cache.
  Network or malformed-response failures must not be cached as empty catalogs.
- `src/knowledge-activity-state.ts`: per-session selection transitions. Changing
  knowledge base clears an unrelated document; notes retain their own path.
  Empty or not-yet-loaded sessions open the workspace because DSH does not
  allocate a details column for those sessions.
- `src/latest-request.ts`: request cancellation owner, shared by initial load,
  refresh and pagination. Ignore aborted responses before committing view state.
- `src/storage/migrations.ts`: versioned SQLite upgrades, preserving existing
  schemas and transaction boundaries. The provider owns the database lifetime.
- `src/notes/share-page.ts` / `share-page-styles.ts`: safe shared-page rendering
  and its stylesheet. Shared pages require no editor bundle or runtime framework.

## Performance rules

Menu visibility and loading progress updates must not reconstruct the workspace
or destroy note editor instances. Keep the heavyweight editor lazy-loaded.
Cancel superseded reads on navigation and unmount. Disconnect observers and
remove event listeners when their control lifetime ends. Prefer small targeted
updates over document-wide layout work or decorative animation.

The existing application orchestrator and provider remain public entry points;
this refactor does not replace persistence, authorization or write-back logic.
Further domain extraction should be driven by behavioral tests, not file-size
targets or another shared package dependency.

## Verification

Run `npm test` for API, persistence, permission, migration and UI-state tests.
For real Chromium checks, build first, then run:

```sh
KNOWLEDGE_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node scripts/verify-ui.mjs
```

The browser check creates an isolated temporary database and note files. It
checks desktop/mobile/tablet widths, both modes, overflow, editor preservation,
custom-select keyboard/reset/validation, dynamic options and modal dismissal.
Screenshots are retained in the printed temporary directory for visual review.
It never writes to a live DSH profile.
