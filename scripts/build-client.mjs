#!/usr/bin/env node
/**
 * Build the browser half.
 *
 * The web client loads plugin bundles as classic scripts that register a
 * factory with `window.__ModuleLoader__`; the factory body receives a
 * synchronous `require` bound to the module table. The source in
 * `src/client/factory.js` is that body verbatim, so this script only wraps it
 * in the registration header and the `module.exports` footer — there is no
 * transform step, and the built file is readable in the browser devtools.
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

const header = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(ID)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  '',
].join('\n')

const footer = ['', '\t\treturn module.exports;', '\t}', '});', ''].join('\n')

const target = join(root, 'lib/client.js')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, header + body + footer)
process.stdout.write(`wrote ${target} (${String((header + body + footer).length)} bytes)\n`)
