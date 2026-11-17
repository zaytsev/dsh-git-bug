import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = name => readFileSync(join(ROOT, name), 'utf8')

/** One selector per rule, in source order (comments and at-rules skipped). */
function selectorsOf(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('@'))
    .map(line => (line.includes('{') ? line.slice(0, line.indexOf('{')) : line))
    .filter(selector => selector.length > 0)
}

test('the built bundle carries every rule from the stylesheet', () => {
  const selectors = selectorsOf(read('src/client/styles.css'))
  assert.ok(selectors.length > 20, 'expected the stylesheet to have rules, got ' + String(selectors.length))
  const bundle = read('lib/client.js')
  const missing = selectors.filter(selector => !bundle.includes(selector + '{'))
  assert.deepEqual(missing, [], 'lib/client.js is stale: run npm run build')
})

test('the stylesheet is the only place CSS is authored', () => {
  const factory = read('src/client/factory.js')
  const longest = Math.max(...factory.split('\n').map(line => line.length))
  assert.ok(longest < 400, 'src/client/factory.js has a ' + String(longest) + '-char line; CSS belongs in styles.css')
  assert.doesNotMatch(factory, /const CSS = /, 'the factory must not carry a CSS literal')
})

test('the build is deterministic and self-contained', () => {
  const before = read('lib/client.js')
  execFileSync(process.execPath, [join(ROOT, 'scripts/build-client.mjs')], { cwd: ROOT })
  const after = read('lib/client.js')
  assert.equal(after, before, 'a rebuild of unchanged sources must produce identical bytes')
  assert.match(after, /const CSS = "/, 'the bundle inlines the stylesheet')
  assert.match(after, /^window\.__ModuleLoader__\.load\(\{$/m)
})
