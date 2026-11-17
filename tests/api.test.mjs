import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApiHandler } from '../src/server/api.js'
import { normalizeConfig } from '../src/server/index.js'
import { adapter, makeRepo, TEST_ENV } from './support.mjs'

/**
 * Mount the API on a real HTTP server bound to an ephemeral port.
 * @param repoPath - repository the plugin is bound to.
 * @returns the base URL, the board, and a close function.
 */
async function mount(repoPath) {
  const repo = adapter(repoPath)
  const config = normalizeConfig({ repoPath, apiPath: '/git-bug/v1', autoCreateIdentity: false })
  const handler = createApiHandler({ repo, config, availability: async () => ({ available: true, version: 'v-test' }) })
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}/git-bug/v1`
  return { base, repo, close: () => new Promise(resolve => server.close(resolve)) }
}

test('serves the overview, creates an issue, comments, and closes it', async () => {
  const repoPath = await makeRepo()
  const api = await mount(repoPath)
  try {
    const overview = await (await fetch(`${api.base}/overview`)).json()
    assert.equal(overview.repoPath, repoPath)
    assert.equal(overview.counts.total, 0)
    assert.equal(overview.remote, 'origin')
    assert.equal(overview.taskLabel, 'ai')
    assert.deepEqual(overview.labelsInUse, [], 'no labels before the first issue')
    assert.equal(overview.availability.available, true)
    assert.equal(overview.identity.name, 'Agent')

    const created = await (await fetch(`${api.base}/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Panel task', message: 'do it', labels: ['agent-task'] }),
    })).json()
    assert.match(created.humanId, /^[0-9a-f]{7}$/)

    const listed = await (await fetch(`${api.base}/issues?status=open`)).json()
    assert.equal(listed.issues.length, 1)
    assert.equal(listed.issues[0].title, 'Panel task')

    // The search box is literal: a half-typed qualifier is a title term, so it
    // matches nothing instead of returning git-bug's parse error.
    const literal = await (await fetch(`${api.base}/issues?status=open&search=${encodeURIComponent('status:')}`)).json()
    assert.deepEqual(literal.issues, [])
    const byLabel = await (await fetch(`${api.base}/issues?label=agent-task`)).json()
    assert.equal(byLabel.issues.length, 1, 'label filters are structured')

    // An explicit query is validated before it reaches the CLI, so the panel
    // shows the accepted vocabulary rather than a raw git-bug diagnostic.
    const rejected = await fetch(`${api.base}/issues?query=${encodeURIComponent('status:')}`)
    assert.equal(rejected.status, 400)
    const failure = await rejected.json()
    assert.equal(failure.kind, 'invalid-filter')
    assert.match(failure.error, /empty value/)
    assert.match(failure.error, /status: label:/)
    assert.deepEqual(listed.issues[0].labels, ['agent-task'])

    const id = created.humanId
    const detail = await (await fetch(`${api.base}/issues/${id}`)).json()
    assert.equal(detail.comments.length, 1)

    const commented = await fetch(`${api.base}/issues/${id}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'from the panel' }),
    })
    assert.equal(commented.status, 200)

    const labelled = await (await fetch(`${api.base}/issues/${id}/labels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'ui', action: 'add' }),
    })).json()
    assert.equal(labelled.label, 'ui')

    const closed = await (await fetch(`${api.base}/issues/${id}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'closed' }),
    })).json()
    assert.equal(closed.status, 'closed')

    const afterClose = await (await fetch(`${api.base}/overview`)).json()
    assert.ok(afterClose.labelsInUse.includes('agent-task'), 'labels in use reach the panel')
    assert.equal(afterClose.counts.closed, 1)
    assert.equal(afterClose.counts.open, 0)
    assert.deepEqual(afterClose.issues[0].labels.sort(), ['agent-task', 'ui'])
  } finally {
    await api.close()
  }
})

test('reports failures with the status the panel can act on', async () => {
  const repoPath = await makeRepo()
  const api = await mount(repoPath)
  try {
    const missing = await fetch(`${api.base}/issues/deadbeef`)
    assert.equal(missing.status, 404)
    const body = await missing.json()
    assert.equal(body.kind, 'not-found')

    const unknown = await fetch(`${api.base}/nope`)
    assert.equal(unknown.status, 404)
    assert.equal((await unknown.json()).kind, 'bad-request')

    const badBody = await fetch(`${api.base}/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    assert.equal(badBody.status, 400)
    assert.match((await badBody.json()).error, /not valid JSON/)

    const arrayBody = await fetch(`${api.base}/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    })
    assert.equal(arrayBody.status, 400)
    assert.match((await arrayBody.json()).error, /JSON object/)

    const wrongMethod = await fetch(`${api.base}/overview`, { method: 'POST' })
    assert.equal(wrongMethod.status, 405)

    const emptyTitle = await fetch(`${api.base}/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    })
    assert.equal(emptyTitle.status, 400)
    assert.match((await emptyTitle.json()).error, /non-empty title/)
  } finally {
    await api.close()
  }
})

test('maps repository state onto conflict and unavailability statuses', async () => {
  const withoutIdentity = await makeRepo({ identity: false })
  const conflict = await mount(withoutIdentity)
  try {
    const created = await fetch(`${conflict.base}/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'needs identity' }),
    })
    assert.equal(created.status, 409)
    assert.equal((await created.json()).kind, 'no-identity')

    const identity = await (await fetch(`${conflict.base}/identity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Panel', email: 'panel@example.com' }),
    })).json()
    assert.equal(identity.created, true)
    assert.equal(identity.identity.name, 'Panel')

    const read = await (await fetch(`${conflict.base}/identity`)).json()
    assert.equal(read.identity.name, 'Panel')
  } finally {
    await conflict.close()
  }

  const notARepo = await mount(makeRepoPathOnly())
  try {
    const response = await fetch(`${notARepo.base}/issues`)
    assert.equal(response.status, 409)
    assert.equal((await response.json()).kind, 'not-a-repository')
  } finally {
    await notARepo.close()
  }
})

/** A directory that exists but is not a git repository. */
function makeRepoPathOnly() {
  return mkdtempSync(join(tmpdir(), 'dsh-git-bug-plain-'))
}

test('sync round-trips through the API', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-git-bug-api-sync-'))
  const origin = join(root, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', origin], { env: TEST_ENV })
  const producer = await makeRepo({ root: join(root, 'producer') })
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: producer, env: TEST_ENV })
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: producer, env: TEST_ENV })

  const api = await mount(producer)
  try {
    await fetch(`${api.base}/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Share me' }),
    })
    const push = await (await fetch(`${api.base}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'push' }),
    })).json()
    assert.equal(push.direction, 'push')
    assert.equal(push.remote, 'origin')
  } finally {
    await api.close()
  }

  const consumer = join(root, 'consumer')
  execFileSync('git', ['clone', '-q', origin, consumer], { env: TEST_ENV })
  const consumerApi = await mount(consumer)
  try {
    const pull = await (await fetch(`${consumerApi.base}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pull' }),
    })).json()
    assert.equal(pull.direction, 'pull')
    const issues = await (await fetch(`${consumerApi.base}/issues`)).json()
    assert.equal(issues.issues.length, 1)
    assert.equal(issues.issues[0].title, 'Share me')
  } finally {
    await consumerApi.close()
  }
})