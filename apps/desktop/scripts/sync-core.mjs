// Copy the extension's shared logic into the webview, so the desktop companion
// picks the dressed-vs-automatic sprite exactly as the extension and badge do.
// Run automatically before `tauri dev` / `tauri build` (see tauri.conf.json).
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const from = join(here, '..', '..', 'extension', 'common', 'core.js')
const to = join(here, '..', 'src', 'vendor', 'core.js')
mkdirSync(dirname(to), { recursive: true })
copyFileSync(from, to)
console.log('synced extension core.js -> src/vendor/core.js')
