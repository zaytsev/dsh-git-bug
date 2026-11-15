import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, normalizeConfig } from '../src/server/index.js'
import { fakeContext, makeRepo } from './support.mjs'

/** Expected tool surface. */
const TOOL_NAMES = [
  'git_bug_list',
  'git_bug_show',
  'git_bug_create',
  'git_bug_comment',
  'git_bug_status',
  'git_bug_label',
  'git_bug_sync',
  'git_bug_identity',
]

/** Poll until the predicate holds or the deadline passes. */
async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for a condition')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** Start the plugin on a fake context bound to one repository. */
async function activate(repoPath, overrides = {}) {
  const fake = fakeContext(overrides.fake)
  await apply(fake.ctx, { repoPath, cacheTtlMs: 50, ...overrides.config })
  return fake
}

test('registers the whole tool family with model-facing metadata', async () => {
  const repoPath = await makeRepo()
  const fake = await activate(repoPath)
  assert.deepEqual(fake.tools.map(tool => tool.name).sort(), [...TOOL_NAMES].sort())
  assert.equal(new Set(fake.tools.map(tool => tool.name)).size, TOOL_NAMES.length)
  for (const tool of fake.tools) {
    assert.ok(tool.description.length > 60, `${tool.name} needs a useful description`)
    assert.equal(tool.parameters.type, 'object', `${tool.name} must send an object-rooted JSON Schema`)
    assert.equal(typeof tool.parameters.properties, 'object')
    for (const name of tool.parameters.required ?? []) {
      assert.ok(name in tool.parameters.properties, `${tool.name} requires undeclared parameter ${name}`)
    }
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.output.schema, 'object')
    const view = tool.presentCall({ id: 'abc', title: 'x', status: 'open', action: 'push', create: true })
    assert.equal(view.card, 'generic')
    assert.equal(typeof view.title, 'string')
    assert.ok(view.title.length > 0)
  }
})

test('tool descriptions steer the agent to the shared task list', async () => {
  const repoPath = await makeRepo()
  const fake = await activate(repoPath)
  const byName = new Map(fake.tools.map(tool => [tool.name, tool]))
  assert.match(byName.get('git_bug_list').description, /shared task list/)
  assert.match(byName.get('git_bug_create').description, /agent-task/)
  assert.match(byName.get('git_bug_sync').description, /push|pull/)
  assert.match(byName.get('git_bug_show').description, /comments/)
})

test('the registered tools read and write through git-bug', async () => {
  const repoPath = await makeRepo()
  const fake = await activate(repoPath)
  const byName = new Map(fake.tools.map(tool => [tool.name, tool]))
  const exec = { signal: undefined }

  const created = await byName.get('git_bug_create').execute({ title: 'Task from the agent', message: 'plan', labels: ['agent-task'] }, exec)
  assert.match(created.humanId, /^[0-9a-f]{7}$/)

  const listed = await byName.get('git_bug_list').execute({ status: 'open' }, exec)
  assert.equal(listed.issues.length, 1)
  const listText = byName.get('git_bug_list').output.render({}, listed)[0].text
  assert.match(listText, /Task from the agent/)
  assert.match(listText, /1 open/)

  const shown = await byName.get('git_bug_show').execute({ id: created.humanId }, exec)
  const detailText = byName.get('git_bug_show').output.render({}, shown)[0].text
  assert.match(detailText, /Task from the agent/)
  assert.match(detailText, /plan/)

  await byName.get('git_bug_comment').execute({ id: created.humanId, message: 'halfway' }, exec)
  const commented = await byName.get('git_bug_show').execute({ id: created.humanId }, exec)
  assert.deepEqual(commented.comments.map(comment => comment.message), ['plan', 'halfway'])

  await byName.get('git_bug_label').execute({ id: created.humanId, label: 'ui', action: 'add' }, exec)
  assert.deepEqual((await byName.get('git_bug_show').execute({ id: created.humanId }, exec)).labels.sort(), ['agent-task', 'ui'])
  await byName.get('git_bug_label').execute({ id: created.humanId, label: 'ui', action: 'remove' }, exec)
  assert.deepEqual((await byName.get('git_bug_show').execute({ id: created.humanId }, exec)).labels, ['agent-task'])

  await byName.get('git_bug_status').execute({ id: created.humanId, status: 'closed' }, exec)
  assert.equal((await byName.get('git_bug_list').execute({ status: 'closed' }, exec)).issues.length, 1)

  const identity = await byName.get('git_bug_identity').execute({}, exec)
  assert.equal(identity.identity.name, 'Agent')
  const identityText = byName.get('git_bug_identity').output.render({}, identity)[0].text
  assert.match(identityText, /identity: Agent/)
})

test('tool failures explain how to recover', async () => {
  const repoPath = await makeRepo({ identity: false })
  const fake = await activate(repoPath, { config: { autoCreateIdentity: false } })
  const byName = new Map(fake.tools.map(tool => [tool.name, tool]))

  await assert.rejects(
    () => byName.get('git_bug_create').execute({ title: 'no identity' }, {}),
    (error) => {
      assert.match(error.message, /git_bug_identity/)
      return true
    },
  )
  await assert.rejects(
    () => byName.get('git_bug_show').execute({ id: 'deadbeef' }, {}),
    (error) => {
      assert.match(error.message, /git_bug_list/)
      return true
    },
  )
  const created = await byName.get('git_bug_identity').execute({ create: true, name: 'Harness', email: 'h@example.com' }, {})
  assert.equal(created.created, true)
  assert.equal(created.identity.name, 'Harness')
  await byName.get('git_bug_create').execute({ title: 'now writes work' }, {})
})

test('a non-repository path is reported instead of written to', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-git-bug-plugin-'))
  const fake = await activate(dir)
  const list = fake.tools.find(tool => tool.name === 'git_bug_list')
  await assert.rejects(
    () => list.execute({}, {}),
    (error) => {
      assert.match(error.message, /not a git repository/)
      return true
    },
  )
  await waitFor(() => fake.sections.length === 1)
  const section = fake.sections[0].text()
  assert.match(section, /not a git repository/)
})

test('the prompt section carries the board and the usage rules', async () => {
  const repoPath = await makeRepo()
  const fake = await activate(repoPath)
  const list = fake.tools.find(tool => tool.name === 'git_bug_list')
  const create = fake.tools.find(tool => tool.name === 'git_bug_create')
  await create.execute({ title: 'Visible in the prompt', labels: ['agent-task'] }, {})

  await waitFor(() => fake.sections[0].text().includes('Visible in the prompt'))
  const section = fake.sections[0]
  assert.equal(section.name, 'dsh-git-bug')
  assert.equal(section.order, 120)

  const text = section.text()
  assert.match(text, /## git-bug issue tracker/)
  assert.match(text, new RegExp(repoPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(text, /git_bug_create/)
  assert.match(text, /todo_write/)
  assert.match(text, /agent-task/)
  assert.match(text, /Open issues/)
  assert.match(text, /1 open/)
  assert.ok(text.indexOf('How to use it:') < text.indexOf('Open issues'), 'instructions stay a stable prefix')
  void list
})

test('a headless composition still registers tools when the web server is absent', async () => {
  const repoPath = await makeRepo()
  const fake = await activate(repoPath, { fake: { webServer: false } })
  assert.equal(fake.tools.length, TOOL_NAMES.length)
  assert.equal(fake.routes.length, 0)
})

test('mounts one prefix route for the panel API', async () => {
  const repoPath = await makeRepo()
  const fake = await activate(repoPath)
  assert.equal(fake.routes.length, 1)
  assert.equal(fake.routes[0].kind, 'prefix')
  assert.equal(fake.routes[0].path, '/git-bug/v1')
  assert.equal(typeof fake.routes[0].handler, 'function')
})

test('reports a missing git-bug executable in the prompt instead of failing load', async () => {
  const repoPath = await makeRepo()
  const fake = fakeContext()
  fake.ctx.subprocess = {
    async resolveExecutable() { throw new Error('not found on PATH') },
    spawn() { throw new Error('must not spawn without an executable') },
  }
  await apply(fake.ctx, { repoPath })
  assert.equal(fake.tools.length, TOOL_NAMES.length)
  await waitFor(() => fake.sections[0].text().includes('NOT available'))
  assert.match(fake.sections[0].text(), /git-bug is NOT available here/)
})

test('config defaults and validation are explicit', () => {
  const defaults = normalizeConfig(undefined)
  assert.equal(defaults.repoPath, process.cwd())
  assert.equal(defaults.remote, 'origin')
  assert.equal(defaults.apiPath, '/git-bug/v1')
  assert.equal(defaults.taskLabel, 'agent-task')
  assert.equal(defaults.autoCreateIdentity, true)
  assert.equal(defaults.promptSection, true)
  assert.equal(defaults.issueListLimit, 25)
  assert.equal(defaults.timeoutMs, 30_000)

  const configured = normalizeConfig({
    repoPath: '/tmp/x/',
    remote: 'upstream',
    apiPath: '/custom/v2/',
    taskLabel: 'todo',
    autoCreateIdentity: false,
    promptSection: false,
    promptOrder: 140,
    issueListLimit: 5,
    timeoutMs: 1000,
    syncTimeoutMs: 2000,
    cacheTtlMs: 100,
    identity: { name: 'Bot', email: 'bot@example.com' },
  })
  assert.equal(configured.repoPath, '/tmp/x')
  assert.equal(configured.apiPath, '/custom/v2')
  assert.equal(configured.remote, 'upstream')
  assert.equal(configured.taskLabel, 'todo')
  assert.equal(configured.autoCreateIdentity, false)
  assert.equal(configured.promptSection, false)
  assert.equal(configured.identity.name, 'Bot')

  assert.throws(() => normalizeConfig({ apiPath: 'nope' }), /must start with/)
  assert.throws(() => normalizeConfig({ promptOrder: Number.NaN }), /finite number/)
  assert.throws(() => normalizeConfig({ issueListLimit: 0 }), /positive integer/)
  assert.throws(() => normalizeConfig({ timeoutMs: -1 }), /positive finite number/)
  assert.throws(() => normalizeConfig('nope'), /must be an object/)
})

test('promptSection false leaves the prompt untouched', async () => {
  const repoPath = await makeRepo()
  const fake = await activate(repoPath, { config: { promptSection: false } })
  assert.equal(fake.sections.length, 0)
  assert.equal(fake.tools.length, TOOL_NAMES.length)
})