/**
 * Client half of the conversation-delete bundle.
 *
 * Adds one destructive row to the Session row's "..." menu and one
 * `shell.overlay` dialog that confirms it. The dialog posts the exact Session
 * id to the Host half's authenticated route; the Host owns stopping conditions,
 * log removal, Workspace cleanup, and the `api-session/removed` notification
 * that drops the row from the list.
 *
 * When the targeted conversation is the one open in the main view, the dialog
 * first opens a fresh conversation and waits for the main view to leave the
 * deleted id (bounded by a fallback delay), so the Conversation never loads a
 * log that is being removed underneath it.
 *
 * @module @local/dsh-conversation-delete/client
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-conversation-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'conversation-delete'
    /** Exact Host route the dialog posts to. */
    const ENDPOINT = '/plugin/dsh-conversation-delete/delete'
    /** Style-tag identity used for idempotent injection. */
    const STYLE_ID = '@local/dsh-conversation-delete/styles'
    /** Grace period after opening a fresh conversation before deleting anyway. */
    const NAVIGATION_FALLBACK_MS = 1500
    /** How long the success state stays on screen. */
    const SUCCESS_HOLD_MS = 1600

    const CSS = [
      '.cd-menuItem{display:flex;align-items:center;gap:6px;width:100%;min-height:30px;padding:4px 8px;border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;cursor:pointer;font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary);text-align:left}',
      '.cd-menuItem:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.cd-menuItem:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px}',
      '.cd-menuIcon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center}',
      '.cd-menuLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cd-backdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:40px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.32));backdrop-filter:var(--dsw-mask-blur,blur(2px));animation:cd-fade .14s ease-out}',
      '.cd-dialog{box-sizing:border-box;position:relative;display:flex;flex-direction:column;gap:18px;width:min(400px,100%);padding:22px 24px 20px;border-radius:var(--dsw-radius-panel,16px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent,0 16px 40px rgba(0,0,0,.28));animation:cd-in .16s ease-out}',
      '.cd-title{margin:0;font-size:16px;line-height:24px;font-weight:600}',
      '.cd-description{margin:8px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;overflow-wrap:anywhere}',
      '.cd-note{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.cd-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.cd-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
      '.cd-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px}',
      '.cd-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;cursor:pointer}',
      '.cd-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.cd-button:disabled{cursor:not-allowed;opacity:.4}',
      '.cd-button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}',
      '.cd-danger{color:var(--dsw-alias-state-error-primary)}',
      '@keyframes cd-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
      '@keyframes cd-fade{from{opacity:0}to{opacity:1}}',
      '@media (prefers-reduced-motion:reduce){.cd-backdrop,.cd-dialog{animation:none}}',
    ].join('\n')

    const zh = {
      'menu.delete': '删除对话',
      'dialog.title': '删除对话？',
      'dialog.description': '“{title}”将被永久删除，无法恢复。',
      'dialog.untitled': '未命名对话',
      'dialog.note': '该对话的日志、工作区记录和缓存都会被移除。',
      'dialog.pending': '正在删除…',
      'dialog.deleting': '正在删除…',
      'dialog.action': '删除',
      'dialog.deletedTitle': '对话已删除',
      'dialog.deletedDesc': '“{title}”及其日志已被移除。',
      'cancel': '取消',
      'close': '关闭',
      'error.notFound': '该对话不存在或已被删除。',
      'error.active': '该对话仍有正在运行的工作，请先停止后再删除。',
      'error.storage': '无法定位对话的存储位置，删除失败。',
      'error.forbidden': '只有本机用户才能删除对话。',
      'error.generic': '删除失败：{message}',
    }

    const en = {
      'menu.delete': 'Delete conversation',
      'dialog.title': 'Delete conversation?',
      'dialog.description': '\u201c{title}\u201d will be permanently deleted and cannot be recovered.',
      'dialog.untitled': 'Untitled conversation',
      'dialog.note': 'Its log, workspace entries, and cached data will be removed.',
      'dialog.pending': 'Deleting\u2026',
      'dialog.deleting': 'Deleting\u2026',
      'dialog.action': 'Delete',
      'dialog.deletedTitle': 'Conversation deleted',
      'dialog.deletedDesc': '\u201c{title}\u201d and its log were removed.',
      'cancel': 'Cancel',
      'close': 'Close',
      'error.notFound': 'This conversation no longer exists.',
      'error.active': 'This conversation still has running work. Stop it before deleting.',
      'error.storage': 'The conversation storage location could not be found, so nothing was deleted.',
      'error.forbidden': 'Only the local owner can delete conversations.',
      'error.generic': 'Delete failed: {message}',
    }

    /** One client-side deletion failure with a Host business code. */
    class DeleteFailure extends Error {
      constructor(code, message) {
        super(message)
        this.name = 'DeleteFailure'
        this.code = code
      }
    }

    /**
     * Observable holding at most one pending confirmation request.
     * @returns the hook source, its opener, and its settlement.
     */
    function createPendingDelete() {
      let state = null
      let seq = 0
      const listeners = new Set()
      const publish = (next) => {
        state = next
        for (const listener of listeners) listener()
      }
      return {
        hook: {
          getSnapshot: () => state,
          subscribe(listener) {
            listeners.add(listener)
            return () => {
              listeners.delete(listener)
            }
          },
        },
        open(request) {
          publish({ ...request, requestId: ++seq })
        },
        settle() {
          publish(null)
        },
      }
    }

    /**
     * Post one deletion to the Host and translate its refusal into a coded error.
     * @param sessionId - conversation to delete.
     * @returns the accepted Host payload.
     */
    async function performDelete(sessionId) {
      let response
      try {
        response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ sessionId }),
        })
      } catch (reason) {
        throw new DeleteFailure('network', reason instanceof Error ? reason.message : String(reason))
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        // A non-JSON carrier response keeps the HTTP status as its reason.
      }
      if (response.ok && payload !== null && payload.ok === true) return payload
      const code = typeof payload?.code === 'string' ? payload.code : `http-${String(response.status)}`
      const message =
        typeof payload?.message === 'string' && payload.message.length > 0
          ? payload.message
          : `HTTP ${String(response.status)}`
      throw new DeleteFailure(code, message)
    }

    /**
     * Localized sentence for one rejection.
     * @param reason - rejected value.
     * @param t - namespace-bound translator.
     * @returns the sentence to show.
     */
    function messageFor(reason, t) {
      if (reason instanceof DeleteFailure) {
        if (reason.code === 'session/not-found') return t('error.notFound')
        if (reason.code === 'session/active') return t('error.active')
        if (reason.code === 'session/storage-unavailable') return t('error.storage')
        if (reason.code === 'forbidden') return t('error.forbidden')
      }
      return t('error.generic', { message: reason instanceof Error ? reason.message : String(reason) })
    }

    /** The destructive icon: a small outlined waste bin. */
    function TrashIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', { d: 'M3 4.5h10' }),
        h('path', { d: 'M6.5 4.5V3.4c0-.5.4-.9.9-.9h1.2c.5 0 .9.4.9.9v1.1' }),
        h('path', { d: 'M4.8 4.5l.5 8c0 .5.4.9.9.9h3.6c.5 0 .9-.4.9-.9l.5-8' }),
        h('path', { d: 'M6.9 7v4M9.1 7v4' }),
      )
    }

    /**
     * The Session row's "..." menu row (order 500, after Copy Session ID).
     * @param props - row identity, the opener, the menu state, and the locale seat.
     * @returns one destructive menu button.
     */
    function DeleteMenuItem({ sessionId, displayTitle, requestDelete, useMenuOpenState, t }) {
      const setMenuOpen = useMenuOpenState()[1]
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          className: 'cd-menuItem',
          onClick: () => {
            setMenuOpen(false)
            requestDelete({ sessionId, displayTitle })
          },
        },
        h('span', { className: 'cd-menuIcon' }, TrashIcon()),
        h('span', { className: 'cd-menuLabel' }, t('menu.delete')),
      )
    }

    /**
     * `shell.overlay` entry: nothing without a pending request, otherwise one
     * dialog keyed by that request so in-flight state dies with it.
     * @param props - the request hook and the injected operations.
     * @returns the open dialog, or null.
     */
    function DeleteOverlay(props) {
      const request = props.useRequest((current) => current)
      if (request === null) return null
      return h(DeleteDialog, { key: request.requestId, request, ...props })
    }

    /**
     * One confirmation dialog with its own in-flight, error, and success state.
     * @param props - request, operations, retention/status hooks, and locale seat.
     * @returns the dialog.
     */
    function DeleteDialog({
      request,
      settle,
      performDelete: del,
      navigateAway,
      useSessionRetainInfo,
      useSessionStatus,
      t,
    }) {
      const [busy, setBusy] = React.useState(false)
      const [waitingForNavigation, setWaitingForNavigation] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [done, setDone] = React.useState(false)
      const running = React.useRef(false)
      const cancelRef = React.useRef(null)
      const openInMain = useSessionRetainInfo(request.sessionId, (info) =>
        (info?.retainedBy?.mainView ?? 0) > 0,
      )
      const sessionRunning = useSessionStatus(
        (statuses) => statuses.get(request.sessionId)?.running === true,
      )
      const displayTitle =
        typeof request.displayTitle === 'string' && request.displayTitle.length > 0
          ? request.displayTitle
          : t('dialog.untitled')

      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          if (running.current || waitingForNavigation) return
          event.preventDefault()
          settle()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [settle, waitingForNavigation])

      React.useEffect(() => {
        if (cancelRef.current !== null) cancelRef.current.focus()
      }, [])

      const run = React.useCallback(async () => {
        if (running.current) return
        running.current = true
        setBusy(true)
        setError(null)
        try {
          await del(request.sessionId)
          setBusy(false)
          setDone(true)
          window.setTimeout(() => {
            settle()
          }, SUCCESS_HOLD_MS)
        } catch (reason) {
          running.current = false
          setBusy(false)
          setError(messageFor(reason, t))
        }
      }, [del, request.sessionId, settle, t])

      React.useEffect(() => {
        if (!waitingForNavigation) return undefined
        if (!openInMain) {
          run()
          return undefined
        }
        const timer = window.setTimeout(() => {
          run()
        }, NAVIGATION_FALLBACK_MS)
        return () => {
          window.clearTimeout(timer)
        }
      }, [waitingForNavigation, openInMain, run])

      const close = () => {
        if (running.current || waitingForNavigation) return
        settle()
      }

      const confirm = () => {
        if (running.current || waitingForNavigation) return
        // A running conversation cannot be deleted; let the Host refuse it
        // without first pulling the user out of the view they are watching.
        if (openInMain && !sessionRunning) {
          setWaitingForNavigation(true)
          navigateAway()
          return
        }
        run()
      }

      return h(
        'div',
        {
          className: 'cd-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) close()
          },
        },
        h(
          'div',
          {
            className: 'cd-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'cd-dialog-title',
            'aria-describedby': 'cd-dialog-description',
          },
          h(
            'div',
            null,
            h(
              'h2',
              { id: 'cd-dialog-title', className: 'cd-title' },
              done ? t('dialog.deletedTitle') : t('dialog.title'),
            ),
            h(
              'p',
              { id: 'cd-dialog-description', className: 'cd-description' },
              done
                ? t('dialog.deletedDesc', { title: displayTitle })
                : t('dialog.description', { title: displayTitle }),
            ),
          ),
          !done && h('p', { className: 'cd-note' }, t('dialog.note')),
          (busy || waitingForNavigation) &&
            h('div', { className: 'cd-status', role: 'status' }, t('dialog.pending')),
          error !== null && h('p', { className: 'cd-error', role: 'alert' }, error),
          h(
            'div',
            { className: 'cd-footer' },
            done
              ? h(
                  'button',
                  { type: 'button', className: 'cd-button', onClick: settle },
                  t('close'),
                )
              : [
                  h(
                    'button',
                    {
                      key: 'cancel',
                      ref: cancelRef,
                      type: 'button',
                      className: 'cd-button',
                      disabled: busy || waitingForNavigation,
                      onClick: close,
                    },
                    t('cancel'),
                  ),
                  h(
                    'button',
                    {
                      key: 'delete',
                      type: 'button',
                      className: 'cd-button cd-danger',
                      disabled: busy || waitingForNavigation,
                      onClick: confirm,
                    },
                    busy || waitingForNavigation ? t('dialog.deleting') : t('dialog.action'),
                  ),
                ],
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      /**
       * Register the locale dictionaries, the menu row, and the confirmation
       * overlay, all owned by this plugin's fiber.
       * @param ctx - Client root context.
       */
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.locale.register(NS, {
              zh,
              en,
            }),
          'conversation-delete: dictionaries',
        )

        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return undefined
          const tag = document.createElement('style')
          tag.dataset.plugin = '@local/dsh-conversation-delete'
          tag.dataset.pluginCss = STYLE_ID
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => {
            tag.remove()
          }
        }, 'conversation-delete: styles')

        const pending = createPendingDelete()
        const navigateAway = () => {
          try {
            ctx.uiWorkspace.startSession()
          } catch (reason) {
            console.warn('[conversation-delete] could not open another conversation:', reason)
          }
        }

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'conversation-delete.dialog',
              order: 50,
              locale: NS,
              inject: () => ({
                hooks: { request: pending.hook },
                settle: pending.settle,
                performDelete,
                navigateAway,
              }),
            },
            DeleteOverlay,
          ),
        )

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register(
            {
              name: 'sidebar.workspaces.session.menu.item',
              id: 'conversation-delete',
              order: 500,
              locale: NS,
              inject: () => ({
                requestDelete: (request) => {
                  pending.open(request)
                },
              }),
            },
            DeleteMenuItem,
          ),
        )
      },
    }
  },
})
