import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Candidate node_modules roots holding a real React install. */
function reactRoots() {
  const roots = []
  if (process.env.DSH_TEST_NODE_MODULES) roots.push(process.env.DSH_TEST_NODE_MODULES)
  if (process.env.DSH_HOME) roots.push(join(process.env.DSH_HOME, 'profiles', 'node_modules'))
  roots.push(join(homedir(), '.config', 'dsh', 'profiles', 'node_modules'))
  return roots
}

/** Load the real React package when this machine has one; null otherwise. */
function loadReact() {
  for (const root of reactRoots()) {
    try {
      const require = createRequire(join(root, 'noop.js'))
      return require('react')
    } catch {
      // Try the next candidate root.
    }
  }
  return null
}

/** A minimal element factory matching React's element contract. */
function createElement(type, props, ...children) {
  const flat = children.flat().filter(child => child !== null && child !== undefined && child !== false)
  return { type, props: { ...(props ?? {}), ...(flat.length > 0 ? { children: flat.length === 1 ? flat[0] : flat } : {}) } }
}

/** Stub React used only for pure structural assertions (no hooks run). */
const stubReact = {
  createElement,
  Fragment: Symbol('fragment'),
  useState() { throw new Error('hooks need the render driver') },
  useEffect() { throw new Error('hooks need the render driver') },
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
  useRef() { throw new Error('hooks need the render driver') },
}

/** Load the built bundle and materialize its factory against one require. */
function loadBundle(reactModule) {
  let handoff = null
  const listeners = new Map()
  const sandbox = {
    window: {
      __ModuleLoader__: { load(value) { handoff = value } },
      addEventListener(type, listener) { listeners.set(type, listener) },
      removeEventListener(type) { listeners.delete(type) },
    },
    document: {
      head: { appendChild() {} },
      createElement() { return { dataset: {}, textContent: '', remove() {} } },
    },
    navigator: { language: 'en' },
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    fetch: async () => { throw new Error('fetch is not stubbed in this test') },
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(SOURCE, sandbox, { filename: 'lib/client.js' })
  assert.ok(handoff !== null, 'the bundle must register with window.__ModuleLoader__')
  const exports = handoff.factory((specifier) => {
    if (specifier === 'react') return reactModule
    throw new Error(`unexpected require("${specifier}")`)
  })
  return { id: handoff.id, exports, sandbox }
}

/** A slot registry + effect tracker shaped like the client plugin context. */
function fakeClientContext() {
  const registrations = []
  const effects = []
  /** Dispose every tracked effect, newest first, so timers do not outlive the test. */
  const disposeAll = () => {
    while (effects.length > 0) {
      const effect = effects.pop()
      effect.dispose()
    }
  }
  return {
    registrations,
    effects,
    disposeAll,
    ctx: {
      effect(fn, label) {
        const dispose = fn()
        effects.push({ label, dispose })
        return () => dispose()
      },
      slots: {
        inject(name, callback) {
          return callback()
        },
        register(options, component) {
          registrations.push({ options, component })
          return () => {}
        },
      },
    },
  }
}

/** Minimal hook driver: enough of React's contract to mount these components. */
function createDriver() {
  const slots = []
  const refs = []
  let cursor = 0
  let dirty = false
  let effects = []

  const hooks = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(slots[index]) : next
        if (value !== slots[index]) {
          slots[index] = value
          dirty = true
        }
      }
      return [slots[index], set]
    },
    useEffect(fn, deps) {
      const index = cursor++
      effects.push({ index, fn, deps })
    },
    useCallback(fn, deps) {
      const index = cursor++
      const previous = slots[index]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.fn
      slots[index] = { fn, deps }
      return fn
    },
    useMemo(fn, deps) {
      const index = cursor++
      const previous = slots[index]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
      const value = fn()
      slots[index] = { value, deps }
      return value
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in refs)) refs[index] = { current: initial }
      return refs[index]
    },
  }

  function sameDeps(left, right) {
    if (left === undefined || right === undefined) return false
    if (left.length !== right.length) return false
    return left.every((value, index) => Object.is(value, right[index]))
  }

  /** Walk the tree, invoking function components and following hooks. */
  function render(node, hostProps) {
    if (Array.isArray(node)) return node.map(child => render(child, hostProps))
    if (node === null || node === undefined || node === false) return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (typeof node === 'function') {
      return render(node(node.__props ?? {}), hostProps)
    }
    if (typeof node.type === 'function') return render(node.type(node.props ?? {}), hostProps)
    const props = node.props ?? {}
    const children = props.children === undefined ? null : render(props.children, hostProps)
    return { type: node.type, props, children }
  }

  return {
    hooks,
    /**
     * Mount one component and settle every effect and state update.
     * @param component - the component function.
     * @param props - its props.
     * @returns the settled element tree.
     */
    async mount(component, props) {
      let tree = null
      for (let pass = 0; pass < 25; pass += 1) {
        cursor = 0
        const pending = []
        const previous = effects
        effects = pending
        const elements = component(props)
        tree = render(elements)
        for (const effect of pending) {
          const before = previous.find(candidate => candidate.index === effect.index)
          if (before !== undefined && sameDeps(before.deps, effect.deps)) continue
          effect.fn()
        }
        await new Promise(resolve => setTimeout(resolve, 0))
        if (!dirty) break
        dirty = false
      }
      return tree
    },
  }
}

/** Read a node's children whether it was rendered by the driver or is a raw element. */
function childOf(node) {
  if (node === null || typeof node !== 'object') return null
  if (node.children !== undefined) return node.children
  return node.props?.children ?? null
}

/** Collect every rendered text leaf. */
function textOf(tree) {
  if (tree === null || tree === undefined) return ''
  if (typeof tree === 'string') return tree
  if (Array.isArray(tree)) return tree.map(textOf).join(' ')
  return textOf(childOf(tree))
}

/** Find the first element matching a predicate. */
function find(tree, predicate) {
  if (tree === null || tree === undefined || typeof tree === 'string') return null
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const hit = find(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (predicate(tree)) return tree
  return find(childOf(tree), predicate)
}

/** Every button carrying one label. */
function buttonByText(tree, label) {
  return find(tree, node => node.type === 'button' && textOf(node).includes(label))
}

test('the built bundle registers one loader id and exports a slot plugin', () => {
  const { id, exports } = loadBundle(stubReact)
  assert.equal(id, 'dsh-git-bug')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual([...exports.inject], ['slots'])
})

test('apply injects styles and registers the sidebar action and the overlay', () => {
  const { exports } = loadBundle(stubReact)
  const { ctx, registrations, effects, disposeAll } = fakeClientContext()
  exports.apply(ctx)

  assert.deepEqual(registrations.map(entry => entry.options.name).sort(), ['shell.overlay', 'sidebar.footer.action'])
  for (const entry of registrations) assert.equal(entry.options.id, 'git-bug')
  assert.deepEqual(effects.map(effect => effect.label), ['dsh-git-bug: styles', 'dsh-git-bug: open issue count'])

  const action = registrations.find(entry => entry.options.name === 'sidebar.footer.action')
  const face = action.options.inject()
  assert.equal(typeof face.show, 'function')
  assert.equal(typeof face.hide, 'function')
  assert.equal(typeof face.loadOverview, 'function')
  assert.equal(typeof face.hooks.visibility.getSnapshot, 'function')
  assert.equal(typeof face.hooks.openCount.getSnapshot, 'function')
  assert.equal(face.hooks.openCount.getSnapshot(), null, 'the count is unknown until the first read lands')

  const hidden = exports.__internals
  assert.equal(hidden.t('issues'), 'Issues')

  disposeAll()
  assert.equal(effects.length, 0, 'every effect, including the count poll, unloads')
})

test('the sidebar action right-aligns the open-issue count', () => {
  const { exports } = loadBundle(stubReact)
  const { ctx, registrations, disposeAll } = fakeClientContext()
  exports.apply(ctx)
  const action = registrations.find(entry => entry.options.name === 'sidebar.footer.action')
  const face = action.options.inject()

  const wide = action.component({ wide: true, show: face.show, useOpenCount: () => 3 })
  assert.equal(wide.type, 'button')
  assert.match(textOf(wide), /Issues/)
  assert.match(textOf(wide), /3/)
  const countSpan = find(wide, node => node.props?.className === 'gb-action-count')
  assert.ok(countSpan !== null, 'the count renders in its own span so CSS can push it right')
  assert.equal(textOf(countSpan), '3')
  assert.match(wide.props.title, /Open issues: 3/)

  // A real zero is a fact and renders; an unknown count (no repository, failed read) does not.
  assert.match(textOf(action.component({ wide: true, show: face.show, useOpenCount: () => 0 })), /0/)
  assert.equal(find(action.component({ wide: true, show: face.show, useOpenCount: () => null }), node => node.props?.className === 'gb-action-count'), null)

  // The collapsed rail keeps one icon: no label, no count.
  const narrow = action.component({ wide: false, show: face.show, useOpenCount: () => 3 })
  assert.doesNotMatch(textOf(narrow), /Issues/)
  assert.equal(find(narrow, node => node.props?.className === 'gb-action-count'), null)

  disposeAll()
})

test('the visibility source publishes only real transitions', () => {
  const { exports } = loadBundle(stubReact)
  const source = exports.__internals.createVisibility()
  const seen = []
  const unsubscribe = source.subscribe(() => seen.push(source.getSnapshot()))
  assert.equal(source.getSnapshot(), false)
  source.hide()
  source.show()
  source.show()
  source.hide()
  unsubscribe()
  source.show()
  assert.deepEqual(seen, [true, false])
  assert.equal(source.getSnapshot(), true)
})

test('the API helper maps server failures onto errors the panel shows', async () => {
  const { exports, sandbox } = loadBundle(stubReact)
  sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ counts: { open: 1 } }) })
  assert.deepEqual(await exports.__internals.api('/overview'), { counts: { open: 1 } })

  sandbox.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: 'no identity', kind: 'no-identity' }) })
  await assert.rejects(() => exports.__internals.api('/issues'), (error) => {
    assert.equal(error.message, 'no identity')
    assert.equal(error.kind, 'no-identity')
    return true
  })

  sandbox.fetch = async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json') } })
  await assert.rejects(() => exports.__internals.api('/issues'), /HTTP 500/)
})

test('stamps timestamps in UTC minutes', () => {
  const { exports } = loadBundle(stubReact)
  assert.equal(exports.__internals.stamp({ time: '2026-11-15T09:51:23Z' }), '2026-11-15 09:51')
  assert.equal(exports.__internals.stamp(null), '')
})

const realReact = loadReact()

test('the panel renders repository truth and drives the API', { skip: realReact === null ? 'no react install found; set DSH_TEST_NODE_MODULES to a node_modules directory holding react' : false }, async () => {
  const calls = []
  const overview = {
    repoPath: '/tmp/repo',
    remote: 'origin',
    identity: { id: 'u1', humanId: 'u1', name: 'Agent', login: '' },
    identities: [{ id: 'u1', humanId: 'u1', name: 'Agent', login: '' }],
    counts: { open: 1, closed: 0, total: 1 },
    issues: [],
    taskLabel: 'agent-task',
    availability: { available: true, version: 'v0.11.0' },
  }
  const summary = {
    id: 'a'.repeat(40),
    humanId: 'aaaaaaa',
    title: 'Render the issues panel',
    status: 'open',
    labels: ['agent-task'],
    createdAt: { time: '2026-11-15T09:00:00Z', epoch: 1 },
    editedAt: { time: '2026-11-15T09:30:00Z', epoch: 2 },
    author: { id: 'u1', humanId: 'u1', name: 'Agent', login: '' },
    participants: [],
    comments: 1,
  }
  const detail = { ...summary, comments: [{ id: 'c1', humanId: 'c1', author: summary.author, message: 'first body', createdAt: null }], commentCount: 1 }

  const driver = createDriver()
  const reactModule = { ...realReact, ...driver.hooks }
  const { exports, sandbox } = loadBundle(reactModule)
  sandbox.fetch = async (url, options) => {
    calls.push({ url, method: options?.method ?? 'GET' })
    const respond = (value) => ({ ok: true, status: 200, json: async () => value })
    if (url.endsWith('/overview')) return respond(overview)
    if (url.includes('/issues?')) return respond({ issues: [summary], taskLabel: 'agent-task' })
    if (url.endsWith('/issues/aaaaaaa')) return respond(detail)
    if (url.endsWith('/issues') && options?.method === 'POST') return respond({ humanId: 'bbbbbbb', title: 'New one', labels: [] })
    if (url.endsWith('/comments')) return respond({ id: 'aaaaaaa' })
    if (url.endsWith('/status')) return respond({ id: 'aaaaaaa', status: 'closed' })
    if (url.endsWith('/sync')) return respond({ remote: 'origin', direction: 'pull', report: '' })
    return respond({})
  }

  const registrations = []
  const effects = []
  const ctx = {
    effect(fn) { const dispose = fn(); effects.push({ dispose }); return dispose },
    slots: {
      inject(_name, callback) { return callback() },
      register(options, component) { registrations.push({ options, component }); return () => {} },
    },
  }
  exports.apply(ctx)

  const overlay = registrations.find(entry => entry.options.name === 'shell.overlay')
  const face = overlay.options.inject()
  const panelProps = { useVisibility: () => true, hide: face.hide, loadOverview: face.loadOverview }
  const tree = await driver.mount(overlay.component, panelProps)

  const rendered = textOf(tree)
  assert.match(rendered, /Git-Bug issues/)
  assert.match(rendered, /Render the issues panel/)
  assert.match(rendered, /agent-task/)
  assert.match(rendered, /aaaaaaa/)
  assert.ok(calls.some(call => call.url.endsWith('/overview')))
  assert.ok(calls.some(call => call.url.includes('/issues?status=open')))

  const row = buttonByText(tree, 'Render the issues panel')
  assert.ok(row !== null, 'the issue row must be a button')
  row.props.onClick()

  const settled = await driver.mount(overlay.component, panelProps)
  assert.match(textOf(settled), /first body/)
  assert.ok(calls.some(call => call.url.endsWith('/issues/aaaaaaa')))

  const closeButton = buttonByText(settled, 'Mark done')
  assert.ok(closeButton !== null)
  closeButton.props.onClick()
  await driver.mount(overlay.component, panelProps)
  assert.ok(calls.some(call => call.url.endsWith('/status') && call.method === 'POST'))
  // The overview the panel renders is the same read that publishes the sidebar count.
  assert.equal(face.hooks.openCount.getSnapshot(), 1)
  face.hide()
  assert.equal(face.hooks.visibility.getSnapshot(), false)
  for (const effect of effects) effect.dispose()
})

test('the overlay renders nothing while closed', { skip: realReact === null ? 'no react install found' : false }, async () => {
  const driver = createDriver()
  const { exports } = loadBundle({ ...realReact, ...driver.hooks })
  const registrations = []
  const effects = []
  const ctx = {
    effect(fn) { const dispose = fn(); effects.push({ dispose }); return dispose },
    slots: { inject(_name, callback) { return callback() }, register(options, component) { registrations.push({ options, component }); return () => {} } },
  }
  exports.apply(ctx)
  const overlay = registrations.find(entry => entry.options.name === 'shell.overlay')
  const face = overlay.options.inject()
  const tree = await driver.mount(overlay.component, { useVisibility: () => false, hide: face.hide, loadOverview: face.loadOverview })
  assert.equal(tree, null)
  for (const effect of effects) effect.dispose()
})