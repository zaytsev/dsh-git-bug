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
function loadBundle(reactModule, primitives) {
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
    if (primitives !== undefined && specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
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

test('issue text uses the shell renderer, and stays readable without one', () => {
  const plain = loadBundle(stubReact).exports.__internals.MarkdownBody({ text: 'a *b*' })
  assert.equal(plain.props.className, 'gb-md')
  const fallback = find(plain, node => node.props?.className === 'gb-plain')
  assert.ok(fallback !== null, 'no renderer is not a crash')
  assert.equal(textOf(fallback), 'a *b*')

  const stub = { MarkdownText: 'markdown-stub' }
  const rich = loadBundle(stubReact, stub).exports.__internals.MarkdownBody({ text: 'a *b*' })
  const rendered = find(rich, node => node.type === 'markdown-stub')
  assert.ok(rendered !== null, 'the platform component is used when it is there')
  assert.equal(rendered.props.text, 'a *b*')
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
    taskLabel: 'ai',
    labelVocabulary: {
      kinds: ['bug', 'feature'],
      priorities: ['priority/low', 'priority/high'],
      severities: ['severity/minor'],
      states: ['blocked'],
      ownership: 'ai',
      componentPrefix: 'component/',
      suggestions: ['bug', 'feature', 'priority/high', 'ai'],
    },
    labelsInUse: ['legacy-thing', 'bug'],
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

  // The shell's Markdown renderer is a platform module: the panel must render issue
  // text through it, and never through a Markdown library of its own.
  const markdownSeen = []
  const primitives = {
    MarkdownText(props) {
      markdownSeen.push(props.text)
      return createElement('md-stub', null, props.text)
    },
  }
  const driver = createDriver()
  const reactModule = { ...realReact, ...driver.hooks }
  const { exports, sandbox } = loadBundle(reactModule, primitives)
  sandbox.fetch = async (url, options) => {
    calls.push({ url, method: options?.method ?? 'GET', body: options?.body })
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
  let tree
  try {
    tree = await driver.mount(overlay.component, panelProps)
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
  assert.ok(markdownSeen.some(text => text.includes('first body')), 'the issue body goes through the shell renderer')
  assert.ok(find(settled, node => node.type === 'md-stub') !== null, 'and renders as Markdown, not as a text node')
  // Titles are plain text: only bodies and comments are Markdown.
  assert.equal(find(settled, node => node.type === 'md-stub' && textOf(node).includes('Render the issues panel')), null)
  assert.ok(calls.some(call => call.url.endsWith('/issues/aaaaaaa')))

  const closeButton = buttonByText(settled, 'Mark done')
  assert.ok(closeButton !== null)
  closeButton.props.onClick()
  await driver.mount(overlay.component, panelProps)
  assert.ok(calls.some(call => call.url.endsWith('/status') && call.method === 'POST'))
  // The create form offers the vocabulary as chips, and the shared datalist backs
  // every label input — one source for the panel and the prompt.
  const openForm = buttonByText(settled, 'New issue')
  assert.ok(openForm !== null, 'the create-form toggle is present')
  openForm.props.onClick()
  const withForm = await driver.mount(overlay.component, panelProps)
  const chip = buttonByText(withForm, 'priority/high')
  assert.ok(chip !== null, 'a suggested label renders as a chip')
  const options = []
  const collectOptions = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(collectOptions); return }
    if (node.type === 'option' && node.props?.value !== undefined) options.push(node.props.value)
    collectOptions(node.children ?? node.props?.children ?? null)
  }
  // Only the datalist's options.
  collectOptions(find(withForm, node => node.props?.id === 'gb-label-options'))
  // Merge rule: configured suggestions first, then the repository's own labels,
  // de-duplicated — the panel never hardcodes a label list of its own.
  const expectedOptions = [...new Set([...overview.labelVocabulary.suggestions, ...overview.labelsInUse])]
  assert.deepEqual([...new Set(options)], expectedOptions)

  // Only two controls are visible until Advanced is opened: the status chips and
  // the filter box. Everything else waits behind the toggle.
  const beforeAdvanced = await driver.mount(overlay.component, panelProps)
  assert.equal(find(beforeAdvanced, node => node.props?.className === 'gb-cloud'), null, 'the label cloud is hidden')
  const advancedButton = buttonByText(beforeAdvanced, 'Advanced')
  assert.ok(advancedButton !== null, 'the advanced toggle is present')
  advancedButton.props.onClick()
  const opened = await driver.mount(overlay.component, panelProps)
  const cloud = find(opened, node => node.props?.className === 'gb-cloud')
  assert.ok(cloud !== null, 'Advanced reveals the label cloud')
  assert.ok(textOf(cloud).includes('legacy-thing'), 'the cloud carries the labels in use')
  assert.ok(textOf(cloud).includes('priority/high'), 'and the configured vocabulary')

  // A label is a toggle in the cloud, not a select: select in place, deselect in
  // place, and each state is a request parameter.
  const cloudChip = buttonByText(cloud, 'legacy-thing')
  assert.ok(cloudChip !== null, 'the label is a chip')
  cloudChip.props.onClick()
  const filtered = await driver.mount(overlay.component, panelProps)
  assert.ok(
    calls.some(call => call.url.includes('/issues?') && call.url.includes('label=legacy-thing')),
    'the chosen label is a request parameter',
  )
  assert.match(textOf(buttonByText(filtered, 'Advanced')), /Advanced · 1/, 'the toggle counts what it hides')
  buttonByText(find(filtered, node => node.props?.className === 'gb-cloud'), 'legacy-thing').props.onClick()
  await driver.mount(overlay.component, panelProps)
  const after = calls.filter(call => call.url.includes('/issues?')).at(-1)
  assert.doesNotMatch(after.url, /label=/, 'deselecting the chip drops the filter')

  // Sort is a server-side ordering, chosen next to the pager.
  const sorted = await driver.mount(overlay.component, panelProps)
  buttonByText(sorted, 'Created').props.onClick()
  await driver.mount(overlay.component, panelProps)
  const ordered = calls.filter(call => call.url.includes('/issues?')).at(-1)
  assert.match(ordered.url, /sort=creation/)
  assert.match(ordered.url, /direction=desc/, 'the default direction survives a sort change')
  buttonByText(sorted, 'Oldest first').props.onClick()
  await driver.mount(overlay.component, panelProps)
  assert.match(calls.filter(call => call.url.includes('/issues?')).at(-1).url, /direction=asc/)

  // One page of a known result set: both pager buttons are inert at the edges.
  const paged = await driver.mount(overlay.component, panelProps)
  const pagerButtons = []
  const collectPager = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(collectPager); return }
    if (node.props?.className === 'gb-pager') { pagerButtons.push(node); return }
    collectPager(node.children ?? node.props?.children ?? null)
  }
  collectPager(paged)
  assert.equal(pagerButtons.length, 1, 'the pager renders once')
  assert.match(textOf(pagerButtons[0]), /1 \/ 1/, 'one page of one match')
  for (const button of [buttonByText(pagerButtons[0], '‹'), buttonByText(pagerButtons[0], '›')]) {
    assert.equal(button.props.disabled, true, 'no page to move to')
  }

  // The filter box is git-bug's query language: it sends the text through whole
  // and lets the CLI read it, instead of flattening it into literal title terms.
  const search = find(filtered, node => node.type === 'input' && node.props?.placeholder === 'Filter with git-bug syntax, e.g. label:ui')
  assert.ok(search !== null, 'the search box says what it accepts')
  search.props.onChange({ target: { value: 'label:ui render  panel' } })
  await driver.mount(overlay.component, panelProps)
  const terms = calls.filter(call => call.url.includes('/issues?')).at(-1)
  assert.equal(new URL(terms.url, 'http://panel.test').searchParams.get('query'), 'label:ui render  panel')
  assert.doesNotMatch(terms.url, /search=/, 'the box is no longer flattened into literal title terms')

  // One sync control replaces the separate pull and push buttons, and it does
  // both directions itself, in order. The API keeps its explicit action.
  const syncButton = buttonByText(filtered, 'Sync')
  assert.ok(syncButton !== null, 'the header carries one sync control')
  assert.equal(buttonByText(filtered, 'Pull'), null, 'no separate pull control')
  assert.equal(buttonByText(filtered, 'Push'), null, 'no separate push control')
  syncButton.props.onClick()
  await driver.mount(overlay.component, panelProps)
  assert.deepEqual(
    calls.filter(call => call.url.endsWith('/sync')).map(call => JSON.parse(call.body).action),
    ['pull', 'push'],
    'sync merges first, then publishes',
  )

  // Paging over a known result set: 45 matches, 20 per page, three pages, and the
  // pager walks them without refetching (the server orders, the panel windows).
  const many = Array.from({ length: 45 }, (unused, index) => ({
    ...summary,
    id: String(index).padStart(4, '0').padEnd(40, '0'),
    humanId: 'page' + String(index),
    title: 'Issue ' + String(index),
  }))
  sandbox.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (url.endsWith('/overview') ? overview : { issues: many, taskLabel: 'ai' }),
  })
  const countRows = (node) => {
    if (node === null || typeof node !== 'object') return 0
    if (Array.isArray(node)) return node.reduce((total, child) => total + countRows(child), 0)
    const self = typeof node.props?.className === 'string' && node.props.className.includes('gb-row') && node.type === 'button' ? 1 : 0
    return self + countRows(node.children ?? node.props?.children ?? null)
  }
  const pagerOf = (tree) => find(tree, node => node.props?.className === 'gb-pager')

  buttonByText(paged, 'Refresh').props.onClick()
  const firstPage = await driver.mount(overlay.component, panelProps)
  assert.equal(countRows(firstPage), 20, 'a page holds PAGE_SIZE rows')
  assert.match(textOf(pagerOf(firstPage)), /1 \/ 3/)

  buttonByText(pagerOf(firstPage), '›').props.onClick()
  const secondPage = await driver.mount(overlay.component, panelProps)
  assert.equal(countRows(secondPage), 20, 'the next page is another PAGE_SIZE rows')
  assert.match(textOf(pagerOf(secondPage)), /2 \/ 3/)
  assert.match(textOf(secondPage), /Issue 20/, 'the window moved with the page')

  buttonByText(pagerOf(secondPage), '›').props.onClick()
  const thirdPage = await driver.mount(overlay.component, panelProps)
  assert.equal(countRows(thirdPage), 5, 'the last page holds the remainder')
  assert.match(textOf(pagerOf(thirdPage)), /3 \/ 3/)
  assert.equal(buttonByText(pagerOf(thirdPage), '›').props.disabled, true, 'and there is nowhere further to go')

  // The overview the panel renders is the same read that publishes the sidebar count.
  assert.equal(face.hooks.openCount.getSnapshot(), 1)
  face.hide()
  assert.equal(face.hooks.visibility.getSnapshot(), false)
  } finally {
    // The count poll owns an interval: a failing assertion must not keep the
    // test runner alive.
    for (const effect of effects) effect.dispose()
  }
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