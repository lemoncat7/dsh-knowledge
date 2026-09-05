# UI ownership and regression boundaries

The plugin owns its component appearance. DSH provides placement and light/dark
mode, not palette values from the active decorative theme. No private shared UI
package or DSH source patch is required.

## Responsibilities

- `src/design-tokens.ts`: canonical light/dark palette and font families. The
  build generates `web/design-tokens.css` from this source; do not edit the
  generated asset. Host client roots receive scoped copies of the same tokens.
  Embedded workspace panes and the activity reader use `KNOWLEDGE_EMBEDDED_MATERIAL`
  for the same surface, filter and control fill. Header/tab sections do not add
  another tint layer; overlapping menus retain an opaque dialog surface.
- `src/theme-bridge.ts` and `web/host-theme.js`: versioned, validated iframe
  theme transport. Only mode and allowlisted plugin tokens cross the boundary.
- `src/client.css` / `src/knowledge-activity.css`: host-side launcher, activity
  reader and conversation status. Do not style host parents or sibling slots.
- `web/styles.css`: management-workspace layout and components. Embedded canvas
  stays transparent; overlaid menus, mobile navigation and outline are solid
  enough to prevent text from showing through.
- `web/ui-primitives.js`: DOM primitives, icons, actions and notifications.
- `web/document-actions.js`: one grouped overflow menu for knowledge and note
  documents, with keyboard navigation, outside dismissal and listener cleanup.
  Save state, outline and primary save remain outside at every viewport width;
  find/history/export/share/rename and lifecycle actions stay in the same menu.
  Do not recreate separate desktop/mobile copies of document actions. Keep the
  editor's overlay stacking below its toolbar, and allow toolbar grid items to
  shrink (`min-width: 0`) without clipping primary buttons.
  Document menus use the neutral menu surface, not the brighter dialog surface:
  high-opacity frost on desktop, solid fill on small/touch screens, reduced
  transparency and browsers without backdrop-filter. Do not animate the filter.
- `web/dialogs.js`: dialog lifetime, dirty-form protection and keyboard focus.
- `web/select-control.js`: plugin-owned select appearance and listbox behavior;
  native value, validation, reset and change semantics remain available to forms.
- `web/model-catalog.js`: coalesced discovery requests and expiring success cache.
  Network or malformed-response failures must not be cached as empty catalogs.
- `src/knowledge-activity-state.ts`: per-session selection transitions. Changing
  knowledge base clears an unrelated document; notes retain their own path.
  Empty or not-yet-loaded sessions open the workspace because DSH does not
  allocate a details column for those sessions.
- `src/knowledge-activity-presentation.tsx`: observes the host column transition,
  holds the plugin reader at a stable width, and releases it after collapse.
  Rapid reversal cancels release; reduced-motion needs no timed wait. Workspace
  handoff releases immediately. Never change the host's CSS or DOM attributes.
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

Cards, buttons and selected tree rows stay in place: use color/border/focus
feedback, not floating transforms or animated shadows. Static metrics should
not pretend to be clickable. Skeletons are static except for one loading-status
indicator. Keep progress on transform rather than width, and do not animate the
desktop grid when resizing/collapsing navigation. Pointer resize writes are
coalesced per frame and flushed on release; keyboard resizing stays immediate.
Dialogs use a short fade without scaling text or fading the full backdrop;
mobile drawers retain directional motion. Reduced-motion disables animations
and transitions entirely, including infinite loaders. Pane material tokens are
independent of motion and must remain unchanged by performance adjustments.

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

`scripts/verify-activity-interaction.mjs` additionally checks the real host column
with an existing test session (read-only). Set `KNOWLEDGE_PLAYWRIGHT_MODULE`,
`DSH_BROWSER_STATE`, and `DSH_TEST_SESSION_TITLE`; optionally `DSH_TEST_URL`.
`KNOWLEDGE_LOCAL_BUNDLE=1` replaces only the knowledge bundle in the test browser
to verify a build before deployment. It checks stable reader width, rapid
close/open reversal, focus exclusion, release and reduced-motion behavior.
