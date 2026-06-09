import * as esbuild from 'esbuild'
import { copyFileSync, mkdirSync, readdirSync, statSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const DIST = join(__dirname, 'dist')
const SRC = __dirname

function copyDir(src, dest, filter = () => true) {
  if (!existsSync(src)) return
  const entries = readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (!filter(srcPath)) continue
    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true })
      copyDir(srcPath, destPath, filter)
    } else {
      mkdirSync(dirname(destPath), { recursive: true })
      copyFileSync(srcPath, destPath)
    }
  }
}

const staticDirs = [
  'sidepanel',
  'player',
  'icons',
  '_locales',
]

const staticFiles = [
  'manifest.json',
]

console.log('[build] Cleaning dist/...')
if (existsSync(DIST)) {
  for (const entry of readdirSync(DIST)) {
    rmSync(join(DIST, entry), { recursive: true, force: true })
  }
}

for (const dir of staticDirs) {
  const src = join(SRC, dir)
  if (existsSync(src)) {
    console.log(`[build] Copying ${dir}/ → dist/${dir}/`)
    copyDir(src, join(DIST, dir))
  }
}

for (const f of staticFiles) {
  const src = join(SRC, f)
  if (existsSync(src)) {
    console.log(`[build] Copying ${f} → dist/${f}`)
    mkdirSync(dirname(join(DIST, f)), { recursive: true })
    copyFileSync(src, join(DIST, f))
  }
}

console.log('[build] Copying onnxruntime-web libs → dist/libs/')
const ortDist = join(__dirname, 'node_modules/onnxruntime-web/dist')
const libsDir = join(DIST, 'libs')
mkdirSync(libsDir, { recursive: true })
copyDir(ortDist, libsDir, (p) => {
  const name = p.toLowerCase()
  return name.endsWith('.min.js') || name.endsWith('.wasm') || name.endsWith('.mjs')
})

async function bundle(entry, outfile) {
  console.log(`[build] Bundling ${entry} → ${outfile}...`)
  await esbuild.build({
    entryPoints: [join(SRC, entry)],
    outfile: join(DIST, outfile),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    treeShaking: true,
    sourcemap: false,
    define: {
      'process.release.name': '"browser"',
      'process.versions.node': '"0.0.0"',
    },
    plugins: [
      {
        name: 'node-shims',
        setup(build) {
          build.onResolve({ filter: /^node:(fs|path|url)$/ }, (args) => {
            const mod = args.path.slice(5)
            return { path: join(SRC, 'shims', `${mod}.js`), namespace: 'file' }
          })
          build.onResolve({ filter: /^node:(events|os|util|stream|child_process|crypto|buffer|string_decoder|timers|assert|process)$/ }, () => {
            return { path: join(SRC, 'shims', 'node-empty.js'), namespace: 'file' }
          })
          build.onResolve({ filter: /^onnxruntime-node$/ }, () => {
            return { path: join(SRC, 'shims', 'onnxruntime-node.js'), namespace: 'file' }
          })
          build.onResolve({ filter: /^@huggingface\/transformers$/ }, () => {
            return { path: join(SRC, 'node_modules', '@huggingface/transformers', 'src', 'transformers.js'), namespace: 'file' }
          })
          build.onResolve({ filter: /^(sharp|detect-libc)$/ }, () => {
            return { path: join(SRC, 'shims', 'node-empty.js'), namespace: 'file' }
          })
          build.onResolve({ filter: /^(child_process|fs|path|os|crypto)$/ }, (args) => {
            return { path: join(SRC, 'shims', 'node-empty.js'), namespace: 'file' }
          })
        },
      },
    ],
  })
}

await bundle('service-worker.js', 'service-worker.js')

await bundle('sidepanel/script.js', 'sidepanel/script.js')

await bundle('player/script.js', 'player/script.js')

await bundle('modules/whisper-worker.js', 'modules/whisper-worker.js')

await bundle('modules/translate-worker.js', 'modules/translate-worker.js')

const localeDir = join(DIST, '_locales', 'en', 'messages.json')

const msgContent = readFileSync(localeDir, 'utf-8')
const msgKeys = new Set()
const keyMatches = msgContent.matchAll(/"(\w+)":\s*\{/g)
for (const m of keyMatches) {
  msgKeys.add(m[1])
}

// manifest.json uses Chrome's native __MSG_xxx__ substitution
const manifestContent = readFileSync(join(DIST, 'manifest.json'), 'utf-8')
for (const m of manifestContent.matchAll(/__MSG_(\w+)__/g)) {
  if (!msgKeys.has(m[1])) {
    console.warn(`[warn] manifest.json: Key "__MSG_${m[1]}__" not found in _locales/en/messages.json`)
  }
}

// HTML uses data-i18n / data-i18n-title attributes, resolved by JS at runtime
for (const file of [join(DIST, 'sidepanel', 'index.html'), join(DIST, 'player', 'index.html')]) {
  const content = readFileSync(file, 'utf-8')
  for (const m of content.matchAll(/data-i18n(?:-title)?="(\w+)"/g)) {
    if (!msgKeys.has(m[1])) {
      console.warn(`[warn] ${file}: data-i18n key "${m[1]}" not found in _locales/en/messages.json`)
    }
  }
  if (/__MSG_\w+__/.test(content)) {
    console.warn(`[warn] ${file}: contains __MSG_xxx__ which Chrome does NOT substitute in HTML files`)
  }
}

console.log('[build] Done!')
