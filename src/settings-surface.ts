/** Settings surface v1, vendored from dsh-knowledge/src/settings-surface.ts.
 * Bundled locally so an independently installed plugin never depends on another plugin's CSS. */
export const settingsSurfaceCss = `
.dsh-plugin-settings.dsh-plugin-settings {
  --ps-pane: rgb(255 255 255 / 16%);
  --ps-control: rgb(255 255 255 / 27%);
  --ps-text: #1d1d1f; --ps-secondary: #515154; --ps-muted: #6e6e73;
  --ps-edge: rgb(60 60 67 / 14%); --ps-accent: #3a3a3c; --ps-on-accent: #fff;
  --ps-hover: rgb(118 118 128 / 9%);
  --gate-surface: var(--ps-pane); --gate-surface-open: var(--ps-pane);
  --gate-surface-raised: var(--ps-control); --gate-border: var(--ps-edge);
  --gate-text: var(--ps-text); --gate-text-secondary: var(--ps-secondary); --gate-text-tertiary: var(--ps-muted);
  --gate-accent: var(--ps-accent); --gate-primary-text: var(--ps-on-accent); --gate-focus: var(--ps-accent);
  --ig-control: var(--ps-control); --ig-edge: var(--ps-edge); --ig-accent: var(--ps-accent);
  --ig-text: var(--ps-text); --ig-muted: var(--ps-muted);
  --ps-glare: rgb(255 255 255 / 70%);
  --ps-shadow: inset 0 1px rgb(255 255 255 / 70%), inset 0 -1px rgb(60 60 67 / 11%), 0 10px 28px rgb(31 31 35 / 8.5%);
  box-sizing: border-box; min-width: 0; margin: 0; padding: 0;
  list-style: none; overflow: hidden; border: 1px solid var(--ps-edge); border-radius: 14px;
  background: linear-gradient(145deg, color-mix(in srgb, var(--ps-glare) 16%, transparent), transparent 58%), var(--ps-pane);
  color: var(--ps-text); box-shadow: var(--ps-shadow), 0 8px 24px rgb(0 0 0 / 5%);
  backdrop-filter: saturate(1.22) contrast(1.03) blur(32px);
  -webkit-backdrop-filter: saturate(1.22) contrast(1.03) blur(32px);
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", Arial, sans-serif;
  font-size: 13px; line-height: 1.5; color-scheme: light;
}
body[data-ds-dark-theme] .dsh-plugin-settings.dsh-plugin-settings {
  --ps-pane: rgb(25 33 35 / 90%); --ps-control: rgb(39 50 53 / 92%);
  --ps-text: #e3eaeb; --ps-secondary: #bbc9cc; --ps-muted: #95a7ab;
  --ps-edge: rgb(184 204 205 / 10%); --ps-accent: #69b6ba; --ps-on-accent: #101819;
  --ps-hover: rgb(105 182 186 / 9%); --ps-glare: rgb(255 255 255 / 16%);
  --ps-shadow: inset 0 1px rgb(255 255 255 / 16%), inset 0 -1px rgb(0 0 0 / 30%), 0 12px 32px rgb(0 0 0 / 30%);
  color-scheme: dark;
}
.dsh-plugin-settings.dsh-plugin-settings:hover,
.dsh-plugin-settings.dsh-plugin-settings:has(> button[aria-expanded=true]) {
  border-color: color-mix(in srgb, var(--ps-edge) 68%, var(--ps-secondary));
}
.dsh-plugin-settings.dsh-plugin-settings:has(> button[aria-expanded=true]) { background: var(--ps-pane); }
.dsh-plugin-settings.dsh-plugin-settings > button {
  display: flex; align-items: center; gap: 12px; width: 100%; min-height: 0;
  margin: 0; padding: 14px 16px; border: 0; border-radius: 12px;
  background: transparent; color: inherit; text-align: left; font: inherit;
}
.dsh-plugin-settings.dsh-plugin-settings > button > span:first-child { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 4px; }
.dsh-plugin-settings.dsh-plugin-settings > button strong { font-size: 15px; font-weight: 600; line-height: 1.4; }
.dsh-plugin-settings.dsh-plugin-settings > button small { color: var(--ps-muted); font-size: 13px; line-height: 1.5; white-space: normal; overflow-wrap: anywhere; }
.dsh-plugin-settings.dsh-plugin-settings > button > :last-child:not(:first-child) { color: var(--ps-muted); font-size: 12px; }
.dsh-plugin-settings.dsh-plugin-settings > div { margin: 0 16px; border-top: 1px solid var(--ps-edge); }
.dsh-plugin-settings.dsh-plugin-settings :is(input:not([type=radio]):not([type=checkbox]),select,textarea) {
  box-sizing: border-box; max-width: 100%; min-width: 0; min-height: 36px;
  padding: 8px 10px; border: 1px solid var(--ps-edge); border-radius: 10px;
  background-color: var(--ps-control); color: var(--ps-text); font: inherit;
}
.dsh-plugin-settings.dsh-plugin-settings select { padding-right: 30px; }
.dsh-plugin-settings.dsh-plugin-settings :is(footer,.dsh-knowledge-settings-actions,.dsh-access-gate-actions) button {
  min-height: 34px; padding: 8px 13px; border: 0; border-radius: 10px; background: var(--ps-hover); color: var(--ps-text); font: inherit;
}
.dsh-plugin-settings.dsh-plugin-settings :is(footer,.dsh-knowledge-settings-actions,.dsh-access-gate-actions) button.is-primary { background: var(--ps-accent); color: var(--ps-on-accent); }
.dsh-plugin-settings.dsh-plugin-settings :focus-visible { outline: 2px solid var(--ps-accent); outline-offset: 2px; }
.dsh-plugin-settings.dsh-plugin-settings > button:focus-visible { outline-offset: -2px; }
.dsh-plugin-settings.dsh-plugin-settings :is(footer,.dsh-knowledge-settings-actions,.dsh-access-gate-actions) { flex-wrap: wrap; }
@media(max-width:640px) {
  .dsh-plugin-settings.dsh-plugin-settings > button > :last-child:not(:first-child) { font-size: 0; }
  .dsh-plugin-settings.dsh-plugin-settings :is(input:not([type=radio]):not([type=checkbox]),select,textarea) { min-height: 44px; font-size: 16px; }
}
@media(prefers-reduced-motion:reduce) { .dsh-plugin-settings.dsh-plugin-settings, .dsh-plugin-settings.dsh-plugin-settings * { transition: none; animation: none; } }
`
