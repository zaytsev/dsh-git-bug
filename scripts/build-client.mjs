#!/usr/bin/env node
/**
 * Build the browser half.
 *
 * The web client loads plugin bundles as classic scripts that register a
 * factory with `window.__ModuleLoader__`; the factory body receives a
 * synchronous `require` bound to the module table. This script wraps
 * `src/client/factory.js` — that body verbatim — in the registration header and
 * the `module.exports` footer, and inlines `src/client/styles.css` as a string
 * constant inside the factory closure.
 *
 * The CSS inlining mirrors the first-party client preset, which compiles
 * `.module.css` files at build time and emits the rules as a string next to the
 * code: styles are authored, reviewed and diffed as CSS, and the browser still
 * receives one script. There is no bundler here, so no class-name hashing — the
 * `gb-` prefix is this plugin's namespace by convention.
 * @module dsh-git-bug/scripts/build-client
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package root: this file lives in `scripts/`. */
const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Registration id the boot graph expects: the loader row name. */
const ID = 'dsh-git-bug'

const body = readFileSync(join(root, 'src/client/factory.js'), 'utf8')
if (/(^|\n)\s*(import|export)\s/.test(body)) {
  throw new Error('src/client/factory.js must be a factory body: no import/export statements')
}
if (/^\t\tconst CSS = /m.test(body)) {
  throw new Error('src/client/factory.js must not declare CSS: it is inlined from src/client/styles.css')
}

const styles = readFileSync(join(root, 'src/client/styles.css'), 'utf8')
if (styles.trim().length === 0) throw new Error('src/client/styles.css is empty')

const header = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(ID)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  `\t\tconst CSS = ${JSON.stringify(styles)};`,
  '',
].join('\n')

const footer = ['', '\t\treturn module.exports;', '\t}', '});', ''].join('\n')

const target = join(root, 'lib/client.js')
mkdirSync(dirname(target), { recursive: true })
const built = header + body + footer
writeFileSync(target, built)
process.stdout.write(`wrote ${target} (${String(built.length)} bytes, ${String(styles.length)} of CSS)\n`)
