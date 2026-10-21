/**
 * Host-half contract test for the conversation-delete bundle.
 *
 * Exercises the registered route with a fake Host Context: a real temporary
 * session-log tree, a fake persistence seam, workspace registry, projection
 * cache domain, activity waterfall, and removal event sink. Run with
 * `node --test tests/host.test.mjs`.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { apply } from '../index.js'

/** Build one request whose body is `payload`. */
function request(payload, options = {}) {
  const stream = Readable.from([Buffer.from(JSON.stringify(payload))])
  stream.method = options.method ?? 'POST'
  stream.headers = { 'content-type': 'application/json', ...options.headers }
  return stream
}

/** Build one response capturing status, headers, and body. */
function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(body) {
      this.writableEnded = true
      this.body = body ?? ''
    },
  }
}

/**
 * Compose one fake Host Context plus the observable side effects.
 * @param options - root, stored snapshots, activity, and live ids.
 * @returns the context and its records.
 */
function context(options) {
  const records = {
    handler: undefined,
    detached: [],
    unpinned: [],
    unarchived: [],
    cacheDeleted: [],
    removed: [],
  }
  const disposers = []
  const ctx = {
    effect(install) {
      const dispose = install()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    webServer: {
      register(route) {
        records.handler = route.handler
        return () => {
          records.handler = undefined
        }
      },
    },
    connection: {
      admit() {
        return options.forbidden === true
          ? { peer: { principal: { kind: 'remote' } } }
          : { peer: { principal: { kind: 'owner' } } }
      },
    },
    sessionPersistence: {
      async stat(sessionId) {
        return options.snapshots.find((snapshot) => snapshot.header.id === sessionId)
      },
      async list() {
        return options.snapshots
      },
      config: { root: options.root },
    },
    workspaceRegistry: {
      list() {
        return [
          {
            sessionIds: options.memberIds ?? [],
            async detachSession(sessionId) {
              records.detached.push(sessionId)
            },
          },
        ]
      },
      async unpinSession(sessionId) {
        records.unpinned.push(sessionId)
      },
      async unarchiveSession(sessionId) {
        records.unarchived.push(sessionId)
      },
    },
    get(name) {
      if (name === 'storageDomain') {
        return {
          get() {
            return {
              table() {
                return {
                  async delete(sessionId) {
                    records.cacheDeleted.push(sessionId)
                  },
                }
              },
            }
          },
        }
      }
      if (name === 'sessions') {
        return {
          get(sessionId) {
            return options.liveIds?.includes(sessionId) ? { id: sessionId } : undefined
          },
        }
      }
      return undefined
    },
    async waterfall() {
      return options.activity ?? []
    },
    emit(name, id) {
      if (name === 'api-session/removed') records.removed.push(id)
    },
  }
  apply(ctx)
  assert.equal(typeof records.handler, 'function', 'route must register')
  return { ctx, records }
}

/** A stored snapshot with only the fields the Host half reads. */
function snapshot(id, cwd, extra = {}) {
  return {
    header: {
      version: 4,
      id,
      createdAt: 1,
      cwd,
      isSeeded: false,
      ...extra,
    },
    revision: 'rev',
  }
}

test('deletes the log tree, cache row, workspace membership, and emits removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-delete-'))
  try {
    const target = snapshot('session-abc', '/work/demo')
    const child = snapshot('session-child', '/work/demo', {
      origin: 'subagent',
      parentSession: 'session-abc',
    })
    const fork = snapshot('session-fork', '/work/demo', {
      parentSession: 'session-abc',
      isSeeded: true,
    })
    for (const id of [target.header.id, child.header.id, fork.header.id]) {
      const directory = join(root, '--work-demo--', id)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'session.v4.jsonl'), '{}\n')
    }
    const { records } = context({
      root,
      snapshots: [target, child, fork],
      memberIds: [target.header.id, child.header.id, fork.header.id],
    })
    const res = response()
    await records.handler(request({ sessionId: target.header.id }), res)
    assert.equal(res.statusCode, 200, res.body)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.deleted.sort(), [child.header.id, target.header.id].sort())
    await assert.rejects(stat(join(root, '--work-demo--', target.header.id)), { code: 'ENOENT' })
    await assert.rejects(stat(join(root, '--work-demo--', child.header.id)), { code: 'ENOENT' })
    assert.equal((await stat(join(root, '--work-demo--', fork.header.id))).isDirectory(), true)
    assert.deepEqual(records.cacheDeleted.sort(), [child.header.id, target.header.id].sort())
    assert.deepEqual(records.detached.sort(), [child.header.id, target.header.id].sort())
    assert.deepEqual(records.unpinned.sort(), [child.header.id, target.header.id].sort())
    assert.deepEqual(records.removed.sort(), [child.header.id, target.header.id].sort())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('refuses a session with running work and leaves its log intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-delete-'))
  try {
    const target = snapshot('session-busy', '/work/demo')
    const directory = join(root, '--work-demo--', target.header.id)
    await mkdir(directory, { recursive: true })
    const { records } = context({
      root,
      snapshots: [target],
      memberIds: [target.header.id],
      activity: [{ kind: 'turn' }],
    })
    const res = response()
    await records.handler(request({ sessionId: target.header.id }), res)
    assert.equal(res.statusCode, 409)
    assert.equal(JSON.parse(res.body).code, 'session/active')
    assert.equal((await stat(directory)).isDirectory(), true)
    assert.deepEqual(records.detached, [])
    assert.deepEqual(records.removed, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('answers 404 for a session that neither persists nor lives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-delete-'))
  try {
    const { records } = context({ root, snapshots: [] })
    const res = response()
    await records.handler(request({ sessionId: 'session-missing' }), res)
    assert.equal(res.statusCode, 404)
    assert.equal(JSON.parse(res.body).code, 'session/not-found')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cleans up an unmaterialized live session without touching the filesystem', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-delete-'))
  try {
    const { records } = context({
      root,
      snapshots: [],
      liveIds: ['session-blank'],
      memberIds: ['session-blank'],
    })
    const res = response()
    await records.handler(request({ sessionId: 'session-blank' }), res)
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(JSON.parse(res.body).deleted, ['session-blank'])
    assert.deepEqual(records.detached, ['session-blank'])
    assert.deepEqual(records.removed, ['session-blank'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects a non-owner peer, a wrong method, and a bad body', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-delete-'))
  try {
    const forbidden = context({ root, snapshots: [], forbidden: true })
    const forbiddenRes = response()
    await forbidden.records.handler(request({ sessionId: 'session-abc' }), forbiddenRes)
    assert.equal(forbiddenRes.statusCode, 403)
    assert.equal(JSON.parse(forbiddenRes.body).code, 'forbidden')

    const allowed = context({ root, snapshots: [] })
    const methodRes = response()
    await allowed.records.handler(
      request({ sessionId: 'session-abc' }, { method: 'GET' }),
      methodRes,
    )
    assert.equal(methodRes.statusCode, 405)

    const mediaRes = response()
    await allowed.records.handler(
      request({ sessionId: 'session-abc' }, { headers: { 'content-type': 'text/plain' } }),
      mediaRes,
    )
    assert.equal(mediaRes.statusCode, 415)

    const idRes = response()
    await allowed.records.handler(request({ sessionId: 42 }), idRes)
    assert.equal(idRes.statusCode, 400)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
