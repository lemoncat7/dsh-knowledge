import { build } from 'esbuild'

const pluginId = '@lemoncat7/dsh-knowledge'

await build({
  entryPoints: ['src/client.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  external: [
    'react',
    'react/jsx-runtime',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-settings-plugins/client',
  ],
  loader: { '.css': 'text' },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
})

await build({
  entryPoints: ['src/web-markdown-preview.ts'],
  outfile: 'web/markdown-preview.js',
  bundle: true,
  format: 'iife',
  globalName: 'DshKnowledgeMarkdown',
  platform: 'browser',
  target: 'es2022',
  minify: true,
})

await build({
  entryPoints: ['src/web-note-editor.ts'],
  outfile: 'web/note-editor.js',
  bundle: true,
  format: 'iife',
  globalName: 'DshKnowledgeNoteEditor',
  platform: 'browser',
  target: 'es2022',
  minify: true,
})

await build({
  entryPoints: ['src/web-note-history.ts'],
  outfile: 'web/note-history.js',
  bundle: true,
  format: 'iife',
  globalName: 'DshKnowledgeNoteHistory',
  platform: 'browser',
  target: 'es2022',
  minify: true,
})

await build({
  entryPoints: ['src/web-change-review.ts'],
  outfile: 'web/change-review.js',
  bundle: true,
  format: 'iife',
  globalName: 'DshKnowledgeReview',
  platform: 'browser',
  target: 'es2022',
  minify: true,
})

await build({
  entryPoints: ['src/web-workspace-effects.ts'],
  outfile: 'web/workspace-effects.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
})
