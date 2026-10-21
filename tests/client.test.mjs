/**
 * Client-half contract test for the conversation-delete bundle.
 *
 * Loads the real browser artifact through a fake `window.__ModuleLoader__`,
 * applies it to a fake Client context, and exercises the menu row and the
 * confirmation dialog with a minimal React surface. Run with
 * `node --test tests/client.test.mjs`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

/** Minimal React surface for calling the plain-JS components. */
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useRef(value) {
    return { current: value }
  },
  useCallback(callback) {
    return callback
  },
}

globalThis.window = { __ModuleLoader__: { load() {} } }
const loaded = []
globalThis.window.__ModuleLoader__ = {
  load(definition) {
    loaded.push(definition)
  },
}
await import('../client.js')
assert.equal(loaded.length, 1, 'client.js must register exactly one module')
const definition = loaded[0]

/** Build the plugin object and the registrations it installs. */
function mount() {
  const registrations = []
  const dictionaries = []
  const ctx = {
    effect(install) {
      const dispose = install()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register(namespace, dicts) {
        dictionaries.push({ namespace, dicts })
        return () => {}
      },
    },
    slots: {
      inject(key, callback) {
        callback()
        return () => {}
      },
      register(options, component) {
        registrations.push({ key: options.name, options, component })
        return () => {}
      },
    },
    uiWorkspace: {
      startSession() {},
    },
  }
  const plugin = definition.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected module ${id}`)
  })
  plugin.apply(ctx)
  return { registrations, dictionaries, plugin }
}

test('registers the menu row, the overlay, and both dictionaries', () => {
  const { registrations, dictionaries, plugin } = mount()
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'uiWorkspace'])
  const ids = registrations.map((entry) => `${entry.key}:${entry.options.id}`)
  assert.deepEqual(ids, [
    'shell.overlay:conversation-delete.dialog',
    'sidebar.workspaces.session.menu.item:conversation-delete',
  ])
  const menu = registrations[1].options
  assert.equal(menu.order, 500, 'destructive row must follow Copy Session ID (450)')
  assert.equal(menu.locale, 'conversation-delete')
  assert.deepEqual(
    dictionaries.map((entry) => entry.namespace),
    ['conversation-delete'],
  )
  assert.ok(dictionaries[0].dicts.zh['menu.delete'].length > 0)
  assert.ok(dictionaries[0].dicts.en['menu.delete'].length > 0)
})

test('the menu row closes the menu and raises one request', () => {
  const { registrations } = mount()
  const component = registrations[1].component
  const requests = []
  let closed
  const element = component({
    sessionId: 'session-abc',
    displayTitle: 'Demo',
    requestDelete: (request) => requests.push(request),
    useMenuOpenState: () => [true, (value) => (closed = value)],
    t: (key) => key,
  })
  assert.equal(element.type, 'button')
  assert.equal(element.props.role, 'menuitem')
  element.props.onClick()
  assert.equal(closed, false)
  assert.deepEqual(requests, [{ sessionId: 'session-abc', displayTitle: 'Demo' }])
})

test('the overlay is absent without a request and confirms into the Host operation', async () => {
  const { registrations } = mount()
  const component = registrations[0].component
  assert.equal(component({ useRequest: (select) => select(null) }), null)

  const calls = []
  const element = component({
    useRequest: (select) => select({ requestId: 1, sessionId: 'session-abc', displayTitle: 'Demo' }),
    settle: () => {},
    performDelete: async (sessionId) => {
      calls.push(sessionId)
      return { ok: true }
    },
    navigateAway: () => {},
    useSessionRetainInfo: (_sessionId, select) => select(undefined),
    useSessionStatus: (_select) => false,
    t: (key, values) => (values === undefined ? key : `${key}:${JSON.stringify(values)}`),
  })
  assert.equal(typeof element.type, 'function')
  const backdrop = element.type(element.props)
  const dialog = backdrop.children[0]
  assert.equal(dialog.props.role, 'dialog')
  assert.equal(dialog.props['aria-modal'], 'true')
  const footer = dialog.children[dialog.children.length - 1]
  const buttons = Array.isArray(footer.children[0]) ? footer.children[0] : footer.children
  assert.equal(buttons.length, 2)
  const deleteButton = buttons[1]
  assert.match(deleteButton.props.className, /cd-danger/)
  deleteButton.props.onClick()
  await Promise.resolve()
  assert.deepEqual(calls, ['session-abc'])
})
