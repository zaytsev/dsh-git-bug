#!/usr/bin/env node
/**
 * Verification harness: a minimal DeepSeek-compatible chat-completions server.
 *
 * It exists so the plugin's agent-facing half can be verified without an API
 * key: the stand-in records every request body (the assembled system prompt
 * and tool schemas) and answers in two beats — first with a `git_bug_list`
 * tool call, then with a final answer once the tool result comes back.
 *
 * Usage: `node scripts/stub-provider.mjs` prints "PORT <n>" once listening and
 * "REQUESTS <path>" for the recorded JSONL file. Close it with SIGTERM.
 * @module dsh-git-bug/scripts/stub-provider
 */

import { mkdtempSync, appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const requestLog = process.env.DSH_STUB_LOG
  ?? join(mkdtempSync(join(tmpdir(), 'dsh-git-bug-stub-')), 'requests.jsonl')

/**
 * Tool calls the stand-in makes, in order, one per successive request. The
 * default reads the shared issue list; a verification run can supply its own
 * plan as JSON in DSH_STUB_PLAN to drive { create, comment, status } as well.
 */
const plan = process.env.DSH_STUB_PLAN
  ? JSON.parse(process.env.DSH_STUB_PLAN)
  : [{ name: 'git_bug_list', args: { status: 'open' } }]

/** Final assistant message once the plan is exhausted. */
const finalText = process.env.DSH_STUB_FINAL ?? 'I used the shared git-bug task list.'

/** One SSE data frame. */
function frame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** Emit one streaming completion, then close the stream. */
function complete(res, chunks) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  for (const chunk of chunks) res.write(frame(chunk))
  res.write('data: [DONE]\n\n')
  res.end()
}

/** The usage frame the adapter expects before [DONE]. */
const USAGE = { choices: [], usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 } }

/** Answer with a tool call so the agent must touch git-bug. */
function toolCall(res, name, args) {
  complete(res, [
    {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id: 'call_stub_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: null,
      }],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    USAGE,
  ])
}

/** Answer with plain text. */
function answer(res, text) {
  complete(res, [
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    USAGE,
  ])
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/requests') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ log: requestLog, count: null }))
    return
  }
  if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
    res.writeHead(404)
    res.end()
    return
  }
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    appendFileSync(requestLog, raw + '\n')
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {
      body = {}
    }
    const messages = Array.isArray(body.messages) ? body.messages : []
    const toolResults = messages.filter(message => message.role === 'tool').length
    const step = plan[toolResults]
    if (step !== undefined) {
      toolCall(res, step.name, step.args)
      return
    }
    answer(res, finalText)
  })
})

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT ${String(server.address().port)}\n`)
  process.stdout.write(`REQUESTS ${requestLog}\n`)
})