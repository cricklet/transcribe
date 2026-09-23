// Builds the whole app into ONE self-contained HTML file: dist/transcribe.html.
// JS, CSS, the chord font and abcjs are all inlined, so the file can be
// opened straight from disk or sent to someone as-is.
//
//   node build.mjs          one build
//   node build.mjs --watch  rebuild on change

import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');

mkdirSync('.build', { recursive: true });
mkdirSync('dist', { recursive: true });
// The RubberBand worklet is inlined as text and started from a Blob URL.
copyFileSync('node_modules/rubberband-web/public/rubberband-processor.js', '.build/rubberband-processor.txt');

// `</script` inside inlined JS would close the tag early.
const safe = js => js.replace(/<\/script/gi, '<\\/script');

function page(appJs) {
  const font = readFileSync('assets/PetalumaScript.woff2').toString('base64');
  const css = [readFileSync('assets/ui.css', 'utf8'), readFileSync('assets/transcribe.css', 'utf8')]
    .join('\n')
    .replace("url('fonts/PetalumaScript.woff2')", `url(data:font/woff2;base64,${font})`);
  const abcjs = readFileSync('node_modules/abcjs/dist/abcjs-basic-min.js', 'utf8');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f0f0f0">
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#181a1b">
  <title>Transcribe</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Reddit+Mono:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
${css}
  </style>
</head>
<body>
  <div id="root"></div>
  <script>
${safe(abcjs)}
  </script>
  <script>
${safe(appJs)}
  </script>
</body>
</html>
`;
}

const writePage = {
  name: 'single-html',
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length) return;
      const js = result.outputFiles.find(f => f.path.endsWith('.js')).text;
      writeFileSync('dist/transcribe.html', page(js));
      const kb = Math.round(Buffer.byteLength(readFileSync('dist/transcribe.html')) / 1024);
      console.log(`dist/transcribe.html  ${kb} KB`);
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ['src/transcribe/index.tsx'],
  bundle: true,
  minify: true,
  write: false,
  outfile: 'dist/app.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.txt': 'text' },
  external: ['path', 'fs', 'crypto'],
  plugins: [writePage],
  logLevel: 'warning',
});

if (watch) {
  await ctx.watch();
  console.log('watching…');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
