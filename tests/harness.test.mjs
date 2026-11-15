import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { TEST_ENV } from './support.mjs'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PATCH = join(PACKAGE_ROOT, 'cordis.patch.yml')
const STUB = join(PACKAGE_ROOT, 'scripts/stub-provider.mjs')

/** Candidate node_modules roots that can resolve the harness packages. */
function moduleRoots() {
  const roots = []
  if (process.env.DSH_TEST_NODE_MODULES) roots.push(process.env.DSH_TEST_NODE_MODULES)
  if (process.env.DSH_HOME) roots.push(join(process.env.DSH_HOME, 'profiles', 'node_modules'))
  roots.push(join(homedir(), '.config', 'dsh', 'profiles', 'node_modules'))
  return roots
}

/** Resolve the harness CLI entry (`@deepseek-ai/dsh`'s bin) or null. */
function resolveHarnessCli() {
  for (const root of moduleRoots()) {
    try {
      const manifest = createRequire(join(root, 'noop.js')).resolve('@deepseek-ai/dsh/package.json')
      return join(dirname(manifest), 'lib/bin.js')
    } catch {
      // Try the next candidate root.
    }
  }
  return null
}

/** Start the stand-in provider and wait for its port line. */
async function startStub(env) {
  const child = spawn(process.execPath, [STUB], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stub provider did not start: ${out}`)), 15_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      out += chunk
      const match = /PORT (\d+)/.exec(out)
      if (match !== null) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  return { child, port }
}

/** Run one command to completion, capturing output. */
function run(argv, options) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, options)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: stderr + String(error.message) }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const cli = resolveHarnessCli()
const skip = cli === null
  ? 'no @deepseek-ai/dsh install resolved; set DSH_TEST_NODE_MODULES to a node_modules directory holding it'
  : false

test('the assembled request carries the board, the tools, and a real tool result', { skip, timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-git-bug-e2e-'))
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  mkdirSync(join(home, 'node_modules'), { recursive: true })
  mkdirSync(repo, { recursive: true })
  symlinkSync(PACKAGE_ROOT, join(home, 'node_modules', 'dsh-git-bug'))
  const requestLog = join(root, 'requests.jsonl')

  // A repository the plugin will read: git, one commit, one identity, one issue.
  const shell = (argv, cwd) => run(['--input-type=module', '--eval', `import {execFileSync} from 'node:child_process';execFileSync(${JSON.stringify(argv[0])}, ${JSON.stringify(argv.slice(1))}, {cwd: ${JSON.stringify(cwd)}, env: process.env, stdio: 'inherit'})`], { env: TEST_ENV })
  await shell(['git', 'init', '-q', '-b', 'main', '.'], repo)
  await shell(['git', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  await shell(['git-bug', 'user', 'new', '--name', 'E2E', '--email', 'e2e@example.com', '--avatar', '', '--non-interactive'], repo)
  await shell(['git-bug', 'bug', 'new', '-t', 'Seeded shared task', '-m', 'Body of the seeded task.', '--non-interactive'], repo)

  const plan = [
    { name: 'git_bug_create', args: { title: 'Agent wrote this', message: 'Written by the verification run.', labels: ['agent-task'] } },
    { name: 'git_bug_list', args: { status: 'open' } },
  ]
  const stubEnv = { ...TEST_ENV, DSH_STUB_LOG: requestLog, DSH_STUB_PLAN: JSON.stringify(plan) }
  const stub = await startStub(stubEnv)
  try {
    // `--expose-internals` is what the installed `dsh` launcher passes: it is
    // what lets the loader resolve out-of-tree plugin rows by package name.
    const result = await run(['--expose-internals', cli, '--profile', 'headless', '--patch', PATCH, 'put the task on the shared list and read it back'], {
      cwd: repo,
      env: {
        ...TEST_ENV,
        HOME: root,
        DSH_HOME: home,
        DSH_TELEMETRY_DISABLED: '1',
        DEEPSEEK_API_KEY: 'stub-key',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(stub.port)}`,
      },
    })
    assert.equal(result.code, 0, `harness run failed:\n${result.stderr.slice(-2000)}`)
    assert.match(result.stdout, /I used the shared git-bug task list/)

    const requests = readFileSync(requestLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(requests.length >= 2, 'the agent must have made at least one tool round trip')

    const first = requests[0]
    const system = first.messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
    assert.match(system, /## git-bug issue tracker/, 'the system prompt carries the plugin section')
    assert.match(system, /Seeded shared task/, 'the section carries the live issue list')
    assert.match(system, /Open issues/)
    assert.match(system, /Repository: `/, 'the section names the repository it acts on')

    const toolNames = first.tools.map(tool => tool.function.name)
    for (const name of ['git_bug_list', 'git_bug_show', 'git_bug_create', 'git_bug_comment', 'git_bug_status', 'git_bug_label', 'git_bug_sync', 'git_bug_identity']) {
      assert.ok(toolNames.includes(name), `the request must offer ${name}`)
    }
    const createSchema = first.tools.find(tool => tool.function.name === 'git_bug_create')
    assert.match(createSchema.function.description, /agent-task/)
    assert.equal(createSchema.function.parameters.properties.title.type, 'string')

    const toolResults = requests
      .flatMap(request => request.messages.filter(message => message.role === 'tool'))
      .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
    assert.ok(toolResults.some(text => /created [0-9a-f]{7} with labels agent-task: Agent wrote this/.test(text)), 'the create tool returned its issue id to the model')
    assert.ok(toolResults.some(text => text.includes('Agent wrote this')), 'the list tool showed the created issue')

    const listed = await run(['--input-type=module', '--eval', 'import {execFileSync} from "node:child_process";process.stdout.write(execFileSync("git-bug", ["bug"], {cwd: process.cwd(), env: process.env}).toString())'], { cwd: repo, env: TEST_ENV })
    assert.match(listed.stdout, /Agent wrote this/, 'the issue really exists in git-bug')
  } finally {
    stub.child.kill('SIGKILL')
  }
})