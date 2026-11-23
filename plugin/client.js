/**
 * B2 中枢 — 侧栏面板（Client 半）。
 *
 * 只做一件事：把「逾期 / 本周 / 未指派」摆出来，勾一下就能完成任务。
 * 数据来自同源端点 /b2-hub/api（Host 半注册），这里不碰文件系统。
 */

window.__ModuleLoader__.load({
  id: '@local/b2-hub',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const API = '/b2-hub/api'

    async function call(op, args) {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, args: args ?? {} }),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status)
      if (!payload || payload.ok !== true) throw new Error(payload && payload.error ? payload.error : '操作失败')
      return payload.value
    }

    const T = {
      bg: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      accent: 'var(--dsw-alias-brand-primary)',
      danger: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    }

    const FONT = { fontFamily: 'inherit', fontSize: 13, color: T.text }

    function Button(props) {
      const primary = props.tone === 'primary'
      return h('button', {
        type: 'button',
        disabled: Boolean(props.disabled),
        onClick: props.onClick,
        style: {
          ...FONT,
          fontSize: 12,
          padding: '3px 10px',
          borderRadius: 6,
          border: '1px solid ' + (primary ? T.accent : T.border),
          background: primary ? T.accent : 'transparent',
          color: primary ? T.bg : T.text,
          cursor: props.disabled ? 'default' : 'pointer',
          opacity: props.disabled ? 0.55 : 1,
          whiteSpace: 'nowrap',
        },
      }, props.children)
    }

    function days(due) {
      if (!due) return null
      const parse = value => {
        const [year, month, day] = value.split('-').map(Number)
        return Date.UTC(year, month - 1, day)
      }
      const now = new Date()
      const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
      return Math.round((parse(due) - today) / 86_400_000)
    }

    function dueLabel(due) {
      const delta = days(due)
      if (delta === null) return '无截止'
      if (delta < 0) return '逾期 ' + -delta + ' 天'
      if (delta === 0) return '今天'
      if (delta <= 7) return delta + ' 天后'
      return due
    }

    /** 任务现在挂在哪个笔记：项目名，或 'inbox'。 */
    function targetOf(task) {
      return task.path.startsWith('10-Projects/') ? (task.path.split('/')[1] || 'inbox') : 'inbox'
    }

    function TaskRow(props) {
      const { task, onToggle, onMove, onSetDue, onSetAssignee, busy, target, projects, people } = props
      const delta = days(task.due)
      const dueColor = delta === null ? T.muted : delta < 0 ? T.danger : delta <= 7 ? T.warn : T.muted
      const multi = task.assignees.length > 1
      // 负责人是一个可展开的多选面板：一个任务可以有多名负责人。
      const [pickerOpen, setPickerOpen] = useState(false)

      const checkbox = h('input', {
        type: 'checkbox',
        checked: Boolean(task.done),
        disabled: Boolean(busy),
        onChange: () => onToggle(task),
        style: { margin: 0, cursor: busy ? 'default' : 'pointer', accentColor: T.accent, flex: '0 0 auto' },
      })

      const date = h('input', {
        type: 'date',
        value: task.due === undefined ? '' : task.due,
        disabled: Boolean(busy),
        title: '截止日期（留空表示清除）',
        onChange: event => onSetDue(task, event.target.value),
        style: {
          ...FONT,
          fontSize: 11,
          color: dueColor,
          background: 'transparent',
          border: 'none',
          cursor: busy ? 'default' : 'pointer',
          width: 112,
          padding: 0,
          flex: '0 0 auto',
        },
      })

      const personLabel = task.assignees.length === 0
        ? '负责人'
        : multi ? task.assignees[0] + ' +' + (task.assignees.length - 1) : task.assignees[0]

      const person = h('button', {
        type: 'button',
        disabled: Boolean(busy),
        title: task.assignees.length === 0
          ? '负责人（点开可多选）'
          : '负责人：' + task.assignees.join('、') + '（点开可多选）',
        onClick: () => setPickerOpen(value => !value),
        style: {
          ...FONT,
          fontSize: 11,
          color: multi ? T.warn : task.assignees.length === 0 ? T.muted : T.text,
          background: 'transparent',
          border: 'none',
          cursor: busy ? 'default' : 'pointer',
          maxWidth: 112,
          padding: 0,
          flex: '0 0 auto',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          textAlign: 'left',
        },
      }, personLabel + (pickerOpen ? ' ▴' : ' ▾'))

      const overdue = delta !== null && delta < 0
      const options = ['inbox'].concat(projects.filter(name => name !== 'inbox'))

      // 两行式：标题独占第一行，日期 / 负责人 / 归属全部下移到第二行。
      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          padding: '7px 0',
          borderBottom: '1px solid ' + T.border,
        },
      },
        h('div', { style: { display: 'flex', gap: 7, alignItems: 'center', minWidth: 0 } },
          checkbox,
          h('div', {
            style: {
              ...FONT,
              fontSize: 12,
              lineHeight: '17px',
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
            title: task.path + ':' + task.line,
          }, task.title),
          overdue
            ? h('span', {
                style: { ...FONT, fontSize: 10, color: T.danger, whiteSpace: 'nowrap', flex: '0 0 auto' },
              }, '逾期 ' + Math.abs(delta) + ' 天')
            : null),
        h('div', {
          style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', paddingLeft: 21, minWidth: 0 },
        },
          date,
          person,
          h('select', {
            value: target,
            disabled: Boolean(busy),
            title: '移到别的笔记',
            onChange: event => onMove(task, event.target.value),
            style: {
              ...FONT,
              fontSize: 11,
              color: T.muted,
              background: 'transparent',
              border: 'none',
              cursor: busy ? 'default' : 'pointer',
              maxWidth: 100,
              padding: 0,
              flex: '0 0 auto',
            },
          }, options.map(name => h('option', { key: name, value: name }, name === 'inbox' ? '收件箱' : name)))),
        pickerOpen
          ? h('div', {
              style: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', paddingLeft: 21, paddingTop: 3 },
            },
            people.length === 0
              ? h('span', { style: { ...FONT, fontSize: 11, color: T.muted } }, '还没有人员笔记，先建人')
              : people.map(name => {
                  const on = task.assignees.includes(name)
                  return h('button', {
                    key: name,
                    type: 'button',
                    disabled: Boolean(busy),
                    onClick: () => onSetAssignee(task, on
                      ? task.assignees.filter(item => item !== name)
                      : task.assignees.concat(name)),
                    style: {
                      ...FONT,
                      fontSize: 11,
                      padding: '1px 8px',
                      borderRadius: 999,
                      border: '1px solid ' + (on ? T.accent : T.border),
                      background: on ? T.accent : 'transparent',
                      color: on ? T.bg : T.text,
                      cursor: busy ? 'default' : 'pointer',
                    },
                  }, (on ? '✓ ' : '') + name)
                }),
            task.assignees.length === 0
              ? null
              : h('button', {
                  type: 'button',
                  disabled: Boolean(busy),
                  onClick: () => onSetAssignee(task, []),
                  style: {
                    ...FONT,
                    fontSize: 11,
                    padding: '1px 8px',
                    borderRadius: 999,
                    border: '1px dashed ' + T.border,
                    background: 'transparent',
                    color: T.muted,
                    cursor: busy ? 'default' : 'pointer',
                  },
                }, '清除'))
          : null)
    }

    function Section(props) {
      const { title, items, empty, busy, onToggle, onMove, onSetDue, onSetAssignee, targetOf, projects, people } = props
      return h('div', { style: { padding: '10px 0 2px' } },
        h('div', { style: { ...FONT, fontSize: 12, fontWeight: 600, color: T.muted, paddingBottom: 2 } }, title + '（' + items.length + '）'),
        items.length === 0
          ? h('div', { style: { ...FONT, fontSize: 12, color: T.muted, padding: '4px 0 6px' } }, empty)
          : items.map((task, index) => h(TaskRow, {
              key: task.path + '#' + task.line + '#' + index,
              task,
              busy,
              onToggle,
              onMove,
              onSetDue,
              onSetAssignee,
              people,
              projects,
              target: targetOf(task),
            })))
    }

    function Panel(props) {
      // 宿主上下文由 apply 传进来：设置页用它调 uiWorkspace.pickDirectory 选文件夹。
      const pluginCtx = props && props.ctx
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [message, setMessage] = useState('')
      const [busy, setBusy] = useState(false)
      const [draft, setDraft] = useState('')
      const [due, setDue] = useState('')
      const [assignee, setAssignee] = useState('')
      const [view, setView] = useState(() => {
        try {
          const stored = window.localStorage.getItem('b2-hub.view')
          return stored === 'project' || stored === 'people' ? stored : 'todo'
        } catch {
          return 'todo'
        }
      })
      const [creating, setCreating] = useState(false)
      const [projectName, setProjectName] = useState('')
      const [width, setWidth] = useState(0)
      const [autoLayout, setAutoLayout] = useState(true)
      const [sortMode, setSortMode] = useState(() => {
        try {
          const stored = window.localStorage.getItem('b2-hub.sort')
          return stored === 'created' || stored === 'load' ? stored : 'urgent'
        } catch {
          return 'urgent'
        }
      })
      const [detail, setDetail] = useState(null)
      const [detailFilter, setDetailFilter] = useState('all')
      const [settingsOpen, setSettingsOpen] = useState(false)
      const rootRef = useRef(null)

      const load = useCallback(async () => {
        try {
          setData(await call('panel'))
          setError('')
        } catch (problem) {
          setError(problem.message)
        }
      }, [])

      useEffect(() => {
        load()
        // 每 60 秒自动刷新一次，面板不用一直手动点。
        const timer = setInterval(load, 60000)
        return () => clearInterval(timer)
      }, [load])

      // 记住上次停留的视角，下次打开直接回到那一页。
      useEffect(() => {
        try {
          window.localStorage.setItem('b2-hub.view', view)
        } catch {
          // 存储不可用时只影响记忆，不影响使用
        }
      }, [view])

      // 排序方式同样记住。
      useEffect(() => {
        try {
          window.localStorage.setItem('b2-hub.sort', sortMode)
        } catch {
          // 同上
        }
      }, [sortMode])

      // 监听容器宽度，自适应排版据此计算列宽与列数。
      useEffect(() => {
        const node = rootRef.current
        if (node === null || node === undefined || typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(entries => {
          const entry = entries[0]
          if (entry !== undefined) setWidth(Math.round(entry.contentRect.width))
        })
        observer.observe(node)
        return () => observer.disconnect()
      }, [])

      const toggle = useCallback(async task => {
        setBusy(true)
        try {
          await call('toggle', { path: task.path, line: task.line })
          await load()
        } catch (problem) {
          setMessage(problem.message)
        } finally {
          setBusy(false)
        }
      }, [load])

      const regenerate = useCallback(async () => {
        try {
          const value = await call('overview')
          setMessage('已生成 ' + value.path)
          await load()
        } catch (problem) {
          setMessage(problem.message)
        }
      }, [load])

      const capture = useCallback(async () => {
        const raw = draft.trim()
        if (raw === '' || busy) return
        // 随手记固定进收件箱（也就是待办页）；归到哪个项目在待办里做。
        // 允许手打 2026-11-20：没有日历标记时，把裸日期转成 📅 记法。
        let text = raw
        const hasMarker = /📅|due::/.test(text)
        if (!hasMarker) {
          const bare = text.match(/\b(\d{4}-\d{2}-\d{2})\b/)
          if (bare !== null) text = text.replace(bare[0], '📅' + bare[1])
        }
        // 日期选择器优先补到末尾（已有日期就不重复加）。
        if (due !== '' && !/📅|due::/.test(text)) text = text + ' 📅' + due
        // 指派选择器：只在文本里还没有这个人时补双链。
        if (assignee !== '' && !text.includes(assignee)) text = text + ` @[[${assignee}]]`
        setBusy(true)
        try {
          const value = await call('capture', { text, target: 'inbox' })
          setDraft('')
          setDue('')
          setAssignee('')
          setMessage('已记到 ' + value.path)
          await load()
        } catch (problem) {
          setMessage(problem.message)
        } finally {
          setBusy(false)
        }
      }, [assignee, busy, draft, due, load])

      // Esc 关闭滑入页。
      useEffect(() => {
        if (detail === null && settingsOpen === false) return
        const onKeyDown = event => {
          if (event.key !== 'Escape') return
          if (detail !== null) setDetail(null)
          setSettingsOpen(false)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [detail, settingsOpen])

      const openPerson = useCallback(async person => {
        try {
          setDetail(await call('personHistory', { name: person.name }))
          setDetailFilter('all')
        } catch (problem) {
          setMessage(problem.message)
        }
      }, [])

      const move = useCallback(async (task, nextTarget) => {
        if (nextTarget === targetOf(task)) return
        setBusy(true)
        try {
          const value = await call('move', { path: task.path, line: task.line, target: nextTarget })
          setMessage('已移到 ' + value.path)
          await load()
        } catch (problem) {
          setMessage(problem.message)
        } finally {
          setBusy(false)
        }
      }, [load])

      const setTaskDue = useCallback(async (task, nextDue) => {
        const current = task.due === undefined ? '' : task.due
        if (nextDue === current) return
        setBusy(true)
        try {
          const value = await call('setDue', { path: task.path, line: task.line, due: nextDue })
          setMessage(value.due === null ? '已清除截止日' : '截止日设为 📅' + value.due)
          await load()
        } catch (problem) {
          setMessage(problem.message)
        } finally {
          setBusy(false)
        }
      }, [load])

      const setTaskAssignee = useCallback(async (task, nextNames) => {
        // 面板改的是「整份名单」：多选就多个人，清空就没人。
        const next = Array.isArray(nextNames) ? nextNames : []
        const same = next.length === task.assignees.length && next.every(name => task.assignees.includes(name))
        if (same) return
        setBusy(true)
        try {
          await call('assign', { path: task.path, line: task.line, names: next })
          setMessage(next.length === 0 ? '已取消负责人' : '负责人已设为 ' + next.join('、'))
          await load()
        } catch (problem) {
          setMessage(problem.message)
        } finally {
          setBusy(false)
        }
      }, [load])

      const createProject = useCallback(async () => {
        const name = projectName.trim()
        if (name === '' || busy) return
        setBusy(true)
        try {
          const value = await call('createProject', { name })
          setProjectName('')
          setCreating(false)
          setMessage('已建项目 ' + value.path)
          await load()
        } catch (problem) {
          setMessage(problem.message)
        } finally {
          setBusy(false)
        }
      }, [busy, load, projectName])

      /** 人员任务历史的滑入页：可筛选、可排序、点遮罩或 ✕ 关闭。 */
      const renderDetail = () => {
        if (detail === null) return null
        const row = (task, done) => h('div', {
          key: (done ? 'done-' : 'active-') + task.path + '#' + task.line,
          style: { padding: '6px 0', borderBottom: '1px solid ' + T.border },
        },
          h('div', { style: { ...FONT, fontSize: 12, lineHeight: '17px', color: done ? T.muted : T.text } },
            (done ? '✓ ' : '') + task.title),
          h('div', { style: { ...FONT, fontSize: 11, color: T.muted, marginTop: 2 } },
            [
              task.project === undefined ? '收件箱' : task.project,
              task.due === undefined ? null : dueLabel(task.due),
              // 多人共同负责时把搭档也列出来，免得以为只有自己。
              task.assignees !== undefined && task.assignees.length > 1 ? task.assignees.join('、') : null,
            ].filter(Boolean).join(' · ')))
        const list = (items, done, emptyText) => items.length === 0
          ? h('div', { style: { ...FONT, fontSize: 12, color: T.muted, padding: '4px 0 6px' } }, emptyText)
          : sortTasks(items).map(task => row(task, done))
        const pill = (active, label, onClick, key) => h('button', {
          key,
          type: 'button',
          onClick,
          style: {
            ...FONT,
            fontSize: 11,
            padding: '2px 8px',
            borderRadius: 999,
            border: '1px solid ' + (active ? T.accent : T.border),
            background: active ? T.accent : 'transparent',
            color: active ? T.bg : T.text,
            cursor: 'pointer',
          },
        }, label)

        return [
          h('div', {
            key: 'detail-backdrop',
            onClick: () => setDetail(null),
            style: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.18)', zIndex: 890 },
          }),
          h('div', {
            key: 'detail-panel',
            style: {
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              width: detailWidth,
              maxWidth: '92%',
              background: T.bg,
              color: T.text,
              borderLeft: '1px solid ' + T.border,
              boxShadow: '-8px 0 24px rgba(0,0,0,0.18)',
              display: 'flex',
              flexDirection: 'column',
              zIndex: 900,
            },
          },
            h('div', {
              style: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px 12px 16px', borderBottom: '1px solid ' + T.border },
            },
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontSize: 15, fontWeight: 600 } }, detail.name),
                h('div', {
                  style: {
                    ...FONT,
                    fontSize: 12,
                    color: T.muted,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                  [detail.role, detail.active.length + ' 个进行中', detail.done.length + ' 个已完成']
                    .filter(Boolean)
                    .join(' · ')))),
            h('div', { style: { display: 'flex', gap: 4, padding: '10px 16px 0' } },
              pill(detailFilter === 'all', '全部', () => setDetailFilter('all'), 'filter-all'),
              pill(detailFilter === 'active', '进行中', () => setDetailFilter('active'), 'filter-active'),
              pill(detailFilter === 'done', '已完成', () => setDetailFilter('done'), 'filter-done')),
            h('div', { style: { display: 'flex', gap: 4, padding: '6px 16px 4px' } },
              pill(sortMode === 'urgent', '紧急度', () => setSortMode('urgent'), 'detail-urgent'),
              pill(sortMode === 'load', '任务量', () => setSortMode('load'), 'detail-load'),
              pill(sortMode === 'created', '创建时间', () => setSortMode('created'), 'detail-created')),
            h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 16px 16px' } },
              detailFilter === 'done' ? null : h('div', { style: { ...FONT, fontSize: 12, fontWeight: 600, color: T.muted, padding: '8px 0 2px' } },
                '进行中（' + detail.active.length + '）'),
              detailFilter === 'done' ? null : list(detail.active, false, '没有进行中的任务'),
              detailFilter === 'active' ? null : h('div', { style: { ...FONT, fontSize: 12, fontWeight: 600, color: T.muted, padding: '12px 0 2px' } },
                '已完成（' + detail.done.length + '）'),
              detailFilter === 'active' ? null : list(detail.done, true, '还没有完成过任务'))),
        ]
      }

      const header = h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '8px 16px',
          borderBottom: '1px solid ' + T.border,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 } },
          h('div', { style: { fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' } }, 'B2 中枢'),
          h('div', {
            style: { ...FONT, fontSize: 11, color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, data === null ? '读取中…' : data.root)),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', {
            type: 'button',
            title: 'B2 中枢设置',
            onClick: () => setSettingsOpen(true),
            style: {
              ...FONT,
              fontSize: 12,
              padding: '3px 8px',
              borderRadius: 6,
              border: '1px solid ' + T.border,
              background: 'transparent',
              color: T.text,
              cursor: 'pointer',
            },
          }, '⚙ 设置'),
          h(Button, { onClick: load, disabled: busy }, '刷新'),
          h(Button, { onClick: regenerate, disabled: busy }, '生成概览')))

      // 设置层必须在「读取中 / 出错」时也能打开：首装库不存在，恰恰是它最该出现的时候。
      const overlayWidth = width > 0 && width < 720
        ? '100%'
        : Math.max(360, Math.min(620, Math.round((width > 0 ? width : 900) * 0.42)))
      const settingsLayer = settingsOpen
        ? [
            h('div', {
              key: 'settings-backdrop',
              onClick: () => setSettingsOpen(false),
              style: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.18)', zIndex: 950 },
            }),
            h('div', {
              key: 'settings-panel',
              style: {
                position: 'absolute',
                top: 0,
                right: 0,
                bottom: 0,
                width: overlayWidth,
                maxWidth: '92%',
                background: T.bg,
                color: T.text,
                borderLeft: '1px solid ' + T.border,
                boxShadow: '-8px 0 24px rgba(0,0,0,0.18)',
                overflowY: 'auto',
                padding: '14px 16px',
                zIndex: 960,
              },
            },
              h(SettingsPage, { onChanged: load, onClose: () => setSettingsOpen(false), ctx: pluginCtx })),
          ]
        : null

      if (error !== '') {
        const missing = /库不存在/.test(error)
        return h('div', { style: { height: '100%', background: T.bg, color: T.text, display: 'flex', flexDirection: 'column' } },
          header,
          h('div', { style: { ...FONT, padding: 20, display: 'flex', flexDirection: 'column', gap: 10 } },
            h('div', { role: 'alert', style: { color: T.danger, lineHeight: '20px' } }, error),
            h('div', { style: { fontSize: 12, color: T.muted, lineHeight: '18px' } },
              missing
                ? '库根目录还不存在。打开设置：填入已有库的路径并保存，或直接点「初始化此库」新建一个。'
                : '可以打开设置检查库根路径。'),
            h('div', { style: { display: 'flex', gap: 8 } },
              h(Button, { tone: 'primary', onClick: () => setSettingsOpen(true) }, '打开设置'),
              h(Button, { onClick: load, disabled: busy }, '重试'))),
          settingsLayer)
      }

      if (data === null) {
        return h('div', { style: { height: '100%', background: T.bg, color: T.text, display: 'flex', flexDirection: 'column' } },
          header,
          h('div', { style: { ...FONT, padding: 20, color: T.muted } }, '读取中…'),
          settingsLayer)
      }

      // 待办页只处理「还没归到项目」的任务（收件箱里的那些）；分给人不影响这里。
      const todoTasks = Array.isArray(data.unfiled) ? data.unfiled : []
      const todoOverdue = todoTasks.filter(task => {
        const delta = days(task.due)
        return delta !== null && delta < 0
      })
      const todoWeek = todoTasks.filter(task => {
        const delta = days(task.due)
        return delta !== null && delta >= 0 && delta <= 7
      })
      const todoNoDue = todoTasks.filter(task => task.due === undefined)

      const summary = [
        data.projects.length + ' 个项目',
        todoTasks.length + ' 个待归项目',
        todoOverdue.length + ' 个逾期',
      ].join('　·　')

      const projects = data.projects.map(project => project.title)
      const people = data.people.map(person => person.name)

      // 自适应排版：同时看容器宽度与项目数量。
      //   · 项目少 → 列宽铺开，避免每列太窄或留大片空白
      //   · 项目多 → 收窄到可读的最小宽度，放不下的横向滚动
      //   · 容器窄 → 改成纵向堆叠
      const available = width > 0 ? width : 900
      const gap = 12
      const minColumn = 260
      const projectCount = Math.max(data.projects.length, 1)
      const natural = Math.max(1, Math.floor((available - 40 + gap) / (340 + gap)))
      const stacked = autoLayout && available < 720
      const columns = Math.min(projectCount, natural)
      const spread = Math.floor((available - 40 - gap * (columns - 1)) / columns)
      const columnWidth = autoLayout
        ? Math.max(minColumn, Math.min(columns === 1 ? 720 : 520, spread))
        : 320

      // 人员视角同样用竖列排版，列宽按人数与容器宽度计算。
      const peopleCount = Math.max(data.people.length, 1)
      const peopleColumns = Math.min(peopleCount, natural)
      const peopleSpread = Math.floor((available - 40 - gap * (peopleColumns - 1)) / peopleColumns)
      const peopleColumnWidth = autoLayout
        ? Math.max(minColumn, Math.min(peopleColumns === 1 ? 720 : 520, peopleSpread))
        : 320

      // 滑入页宽度：窄屏铺满，宽屏占容器约 42%（360–620px 之间）。
      const detailWidth = available < 720 ? '100%' : Math.max(360, Math.min(620, Math.round(available * 0.42)))

      // 排序：创建时间（新→旧）、紧急度（逾期多→少，再看最早截止）、任务量（多→少）。
      const sortedProjects = [...data.projects].sort((left, right) => {        if (sortMode === 'urgent') {
          if (left.overdue !== right.overdue) return right.overdue - left.overdue
          const leftDue = left.earliestDue === undefined ? '9999-12-31' : left.earliestDue
          const rightDue = right.earliestDue === undefined ? '9999-12-31' : right.earliestDue
          if (leftDue !== rightDue) return leftDue.localeCompare(rightDue)
          return left.title.localeCompare(right.title, 'zh')
        }
        if (sortMode === 'load') {
          if (left.open !== right.open) return right.open - left.open
          return left.title.localeCompare(right.title, 'zh')
        }
        const leftCreated = left.created === undefined ? '' : left.created
        const rightCreated = right.created === undefined ? '' : right.created
        if (leftCreated !== rightCreated) return rightCreated.localeCompare(leftCreated)
        return left.title.localeCompare(right.title, 'zh')
      })

      // 任务排序：紧急度看截止日，任务量看工时（没有工时的排后面），创建时间看所在笔记的创建日。
      const sortTasks = list => [...list].sort((left, right) => {
        if (sortMode === 'urgent') {
          const leftDue = left.due === undefined ? '9999-12-31' : left.due
          const rightDue = right.due === undefined ? '9999-12-31' : right.due
          if (leftDue !== rightDue) return leftDue.localeCompare(rightDue)
          return left.line - right.line
        }
        if (sortMode === 'load') {
          const leftEffort = left.effort === undefined ? 0 : left.effort
          const rightEffort = right.effort === undefined ? 0 : right.effort
          if (leftEffort !== rightEffort) return rightEffort - leftEffort
          const leftDue = left.due === undefined ? '9999-12-31' : left.due
          const rightDue = right.due === undefined ? '9999-12-31' : right.due
          return leftDue.localeCompare(rightDue)
        }
        const leftCreated = left.created === undefined ? '' : left.created
        const rightCreated = right.created === undefined ? '' : right.created
        if (leftCreated !== rightCreated) return rightCreated.localeCompare(leftCreated)
        return left.line - right.line
      })

      const sortedPeople = [...data.people].sort((left, right) => {
        if (sortMode === 'load') return right.open - left.open
        if (sortMode === 'urgent') {
          if (left.overdue !== right.overdue) return right.overdue - left.overdue
          return right.open - left.open
        }
        const leftCreated = left.created === undefined ? '' : left.created
        const rightCreated = right.created === undefined ? '' : right.created
        if (leftCreated !== rightCreated) return rightCreated.localeCompare(leftCreated)
        return left.name.localeCompare(right.name, 'zh')
      })

      return h('div', {
        ref: rootRef,
        style: {
          position: 'relative',
          height: '100%',
          background: T.bg,
          color: T.text,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        },
      },
        header,
        h('div', { style: { display: 'flex', gap: 6, padding: '10px 20px 2px' } },
          h('input', {
            type: 'text',
            value: draft,
            disabled: busy,
            placeholder: '记一笔，回车保存（可带 @人名 或 📅2026-11-20）',
            onChange: event => setDraft(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter') capture()
            },
            style: {
              ...FONT,
              flex: 1,
              minWidth: 0,
              padding: '7px 10px',
              borderRadius: 8,
              border: '1px solid ' + T.border,
              background: T.layer1,
              color: T.text,
              outline: 'none',
            },
          }),
          h('input', {
            type: 'date',
            value: due,
            disabled: busy,
            title: '截止日期（可选）',
            onChange: event => setDue(event.target.value),
            style: {
              ...FONT,
              fontSize: 12,
              padding: '0 6px',
              borderRadius: 8,
              border: '1px solid ' + T.border,
              background: T.layer1,
              color: T.text,
              width: 132,
            },
          }),
          h('select', {
            value: assignee,
            disabled: busy,
            title: '负责人（可选；想加多人就再选一次）',
            onChange: event => setAssignee(event.target.value),
            style: {
              ...FONT,
              fontSize: 12,
              padding: '0 6px',
              borderRadius: 8,
              border: '1px solid ' + T.border,
              background: T.layer1,
              color: T.text,
              cursor: busy ? 'default' : 'pointer',
              maxWidth: 100,
            },
          }, [''].concat(data.people.map(person => person.name)).map(name => h('option', {
            key: name === '' ? 'none' : name,
            value: name,
          }, name === '' ? '不指派' : name)))),
        h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: '8px 20px 4px' } },
          h('span', { style: { ...FONT, fontSize: 12, color: T.muted, marginRight: 'auto' } }, summary),
          h('div', { style: { display: 'flex', gap: 4 } },
            [['urgent', '紧急度'], ['load', '任务量'], ['created', '创建时间']].map(([id, label]) => h('button', {
              key: id,
              type: 'button',
              onClick: () => setSortMode(id),
              style: {
                ...FONT,
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 999,
                border: '1px solid ' + (sortMode === id ? T.accent : T.border),
                background: sortMode === id ? T.accent : 'transparent',
                color: sortMode === id ? T.bg : T.text,
                cursor: 'pointer',
              },
            }, label)))),
        h('div', { style: { display: 'flex', gap: 4, padding: '0 20px 4px' } },
          [['todo', '待办'], ['project', '项目'], ['people', '人员']].map(([id, label]) => h('button', {
            key: id,
            type: 'button',
            onClick: () => setView(id),
            style: {
              ...FONT,
              fontSize: 12,
              padding: '3px 12px',
              borderRadius: 999,
              border: '1px solid ' + (view === id ? T.accent : T.border),
              background: view === id ? T.accent : 'transparent',
              color: view === id ? T.bg : T.text,
              cursor: 'pointer',
            },
          }, label))),
        h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 20px 16px' } },
          view === 'project'
            ? h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0 } },
                h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 8, padding: '6px 0 8px' } },
                  h('span', {
                    style: { ...FONT, fontSize: 11, color: T.muted, marginRight: 'auto' },
                  }, data.projects.length + ' 个项目 · 每列 ' + columnWidth + 'px'),
                  h(Button, { onClick: () => setAutoLayout(value => !value) }, autoLayout ? '自适应：开' : '自适应：关'),
                  creating
                    ? h('div', { style: { display: 'flex', gap: 6 } },
                        h('input', {
                          type: 'text',
                          value: projectName,
                          disabled: busy,
                          placeholder: '项目名',
                          onChange: event => setProjectName(event.target.value),
                          onKeyDown: event => {
                            if (event.key === 'Enter') createProject()
                          },
                          style: {
                            ...FONT,
                            padding: '4px 8px',
                            borderRadius: 8,
                            border: '1px solid ' + T.border,
                            background: T.layer1,
                            color: T.text,
                            width: 150,
                          },
                        }),
                        h(Button, { tone: 'primary', onClick: createProject, disabled: busy }, '创建'),
                        h(Button, {
                          onClick: () => {
                            setCreating(false)
                            setProjectName('')
                          },
                          disabled: busy,
                        }, '取消'))
                    : h(Button, { onClick: () => setCreating(true), disabled: busy }, '＋ 新建项目')),
                h('div', {
                  style: {
                    display: 'flex',
                    flexDirection: stacked ? 'column' : 'row',
                    flexWrap: stacked ? 'nowrap' : 'wrap',
                    gap: 12,
                    alignItems: stacked ? 'stretch' : 'flex-start',
                    overflowX: 'hidden',
                    paddingBottom: 12,
                  },
                },
                  data.projects.length === 0
                    ? h('div', { style: { ...FONT, fontSize: 12, color: T.muted, padding: '10px 0' } }, '还没有项目，点右上角新建')
                    : sortedProjects.map(project => h('div', {
                        key: project.path,
                        style: {
                          flex: stacked ? '1 0 auto' : `0 0 ${columnWidth}px`,
                          width: stacked ? '100%' : undefined,
                          maxHeight: '100%',
                          overflowY: 'auto',
                          border: '1px solid ' + T.border,
                          borderRadius: 10,
                          padding: '10px 12px',
                          background: T.layer1,
                        },
                      },
                        h('div', { style: { ...FONT, fontSize: 13, fontWeight: 600, paddingBottom: 2 } }, project.title),
                        h('div', { style: { ...FONT, fontSize: 11, color: T.muted, paddingBottom: 6 } },
                          project.open + ' 个未完成' + (project.overdue > 0 ? ' · 逾期 ' + project.overdue : '')),
                        project.tasks.length === 0
                          ? h('div', { style: { ...FONT, fontSize: 12, color: T.muted, padding: '4px 0 6px' } }, '没有未完成任务')
                          : sortTasks(project.tasks).map((task, index) => h(TaskRow, {
                              key: project.path + '#' + task.line + '#' + index,
                              task,
                              busy,
                              onToggle: toggle,
                              onMove: move,
                              onSetDue: setTaskDue,
                              onSetAssignee: setTaskAssignee,
                              people,
                              projects,
                              target: targetOf(task),
                            }))))))
            : view === 'people'
              ? h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0 } },
                  h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '6px 0 8px' } },
                    h('span', { style: { ...FONT, fontSize: 11, color: T.muted, marginRight: 'auto' } },
                      data.people.length + ' 个人 · 每列 ' + peopleColumnWidth + 'px'),
                    h(Button, { onClick: () => setAutoLayout(value => !value) }, autoLayout ? '自适应：开' : '自适应：关')),
                  h('div', {
                    style: {
                      display: 'flex',
                      flexDirection: stacked ? 'column' : 'row',
                      flexWrap: stacked ? 'nowrap' : 'wrap',
                      gap: 12,
                      alignItems: stacked ? 'stretch' : 'flex-start',
                      overflowX: 'hidden',
                      paddingBottom: 12,
                    },
                  },
                    data.people.length === 0
                      ? h('div', { style: { ...FONT, fontSize: 12, color: T.muted, padding: '10px 0' } }, '还没有人员笔记')
                      : sortedPeople.map(person => h('div', {
                          key: person.name,
                          style: {
                            flex: stacked ? '1 0 auto' : `0 0 ${peopleColumnWidth}px`,
                            width: stacked ? '100%' : undefined,
                            maxHeight: '100%',
                            overflowY: 'auto',
                            border: '1px solid ' + T.border,
                            borderRadius: 10,
                            padding: '10px 12px',
                            background: T.layer1,
                          },
                        },
                          h('div', {
                            style: {
                              ...FONT,
                              fontSize: 13,
                              fontWeight: 600,
                              paddingBottom: 2,
                              cursor: 'pointer',
                              textDecoration: 'underline dotted',
                              textUnderlineOffset: 3,
                            },
                            title: '点击查看该人员的任务历史',
                            onClick: () => openPerson(person),
                          }, person.name),
                          h('div', { style: { ...FONT, fontSize: 11, color: T.muted, paddingBottom: 6 } },
                            [
                              person.role,
                              person.open + ' 个任务',
                              person.overdue > 0 ? '逾期 ' + person.overdue : null,
                            ].filter(Boolean).join(' · ')),
                          person.tasks.length === 0
                            ? h('div', { style: { ...FONT, fontSize: 12, color: T.muted, padding: '4px 0 6px' } }, '没有任务')
                            : sortTasks(person.tasks).map((task, index) => h(TaskRow, {
                                key: person.name + '#' + task.line + '#' + index,
                                // 任务本身带着完整名单：多负责人时不能只显示本列这个人，否则一改就丢掉别人。
                                task,
                                busy,
                                onToggle: toggle,
                                onMove: move,
                                onSetDue: setTaskDue,
                                onSetAssignee: setTaskAssignee,
                                people,
                                projects,
                                target: targetOf(task),
                              }))))))
              : [
                  h(Section, { key: 'overdue', title: '逾期', items: sortTasks(todoOverdue), empty: '没有逾期任务', busy, onToggle: toggle, onMove: move, onSetDue: setTaskDue, onSetAssignee: setTaskAssignee, people, targetOf, projects }),
                  h(Section, { key: 'week', title: '本周', items: sortTasks(todoWeek), empty: '本周没有安排', busy, onToggle: toggle, onMove: move, onSetDue: setTaskDue, onSetAssignee: setTaskAssignee, people, targetOf, projects }),
                  h(Section, { key: 'free', title: '未排期', items: sortTasks(todoNoDue), empty: '没有未排期的任务', busy, onToggle: toggle, onMove: move, onSetDue: setTaskDue, onSetAssignee: setTaskAssignee, people, targetOf, projects }),
                ]),
        message === ''
          ? null
          : h('div', { style: { ...FONT, fontSize: 12, color: T.muted, padding: '6px 20px', borderTop: '1px solid ' + T.border } }, message),
        settingsLayer,
        renderDetail())
    }

    /** 设置页：查看/修改库根路径，并可在这里初始化库。 */
    function SettingsPage(props) {
      const onChanged = props && props.onChanged
      const onClose = props && props.onClose
      const pluginCtx = props && props.ctx
      const [status, setStatus] = useState(null)
      const [path, setPath] = useState('')
      const [feedback, setFeedback] = useState(null)
      const [created, setCreated] = useState(null)
      const [busy, setBusy] = useState(false)

      const say = (tone, text) => setFeedback({ tone, text })

      const refresh = useCallback(async () => {
        try {
          const value = await call('status')
          setStatus(value)
          setPath(current => (current === '' ? value.root : current))
          return value
        } catch (problem) {
          say('danger', problem.message)
          return null
        }
      }, [])

      useEffect(() => {
        refresh()
      }, [refresh])

      /**
       * 用宿主的目录选择器挑文件夹：省掉手打绝对路径。
       * 选完先「探查」这个目录（不保存）：是已有库就显示笔记数，是空目录就提示去初始化。
       */
      const pickFolder = useCallback(async () => {
        const workspace = pluginCtx && pluginCtx.uiWorkspace
        if (workspace === undefined || workspace === null || typeof workspace.pickDirectory !== 'function') {
          say('warn', '当前环境没有目录选择器，请手动填写绝对路径（支持 ~/vault/B2 这种写法）。')
          return
        }
        setBusy(true)
        try {
          const picked = await workspace.pickDirectory()
          if (typeof picked !== 'string' || picked.trim() === '') return
          setPath(picked)
          const value = await call('inspect', { root: picked })
          setStatus(value)
          setCreated(null)
          if (value.exists !== true) {
            say('warn', '这个文件夹还没有 B2 结构：点「初始化此库」建好就能用。')
          } else if (value.readable === false) {
            say('danger', '目录能选中，但读不到：' + (value.reason ?? '未知原因'))
          } else {
            const count = typeof value.notes === 'number' ? '（' + value.notes + ' 篇笔记）' : ''
            say('ok', '已选中已有库' + count + '，点「保存路径」生效。')
          }
        } catch (problem) {
          say('danger', problem.message)
        } finally {
          setBusy(false)
        }
      }, [pluginCtx])

      const saveRoot = useCallback(async () => {
        setBusy(true)
        try {
          const value = await call('saveRoot', { root: path.trim() })
          // 服务端会展开 ~ 与环境变量：把展开后的绝对路径显示回来，避免「我填的和它认的不一样」
          if (typeof value.root === 'string' && value.root !== '') setPath(value.root)
          setStatus({ root: value.root, exists: value.exists === true })
          setCreated(null)
          say(value.exists === true ? 'ok' : 'warn', value.note ?? '已保存')
          // 写配置会重启插件：等它起来再刷新，这段时间把成功提示留在页面上
          window.setTimeout(async () => {
            const fresh = await refresh()
            if (fresh !== null && typeof onChanged === 'function') onChanged()
          }, 3000)
        } catch (problem) {
          say('danger', problem.message)
        } finally {
          setBusy(false)
        }
      }, [path, refresh, onChanged])

      const init = useCallback(async () => {
        // 目录已存在时先问一句：只补缺失项、不动已有文件，但用户应当知道会往里加目录
        if (status !== null && status.exists === true && typeof window.confirm === 'function') {
          const agreed = window.confirm('这个目录已经存在。初始化只会补上缺失的 00-Inbox / 10-Projects / 20-People / 90-Overview.md，不改动已有文件。继续？')
          if (!agreed) return
        }
        setBusy(true)
        try {
          // 用输入框里的路径初始化：用户刚填、还没保存时，也应该作用在他看到的那个路径上
          const value = await call('initLibrary', { root: path.trim() })
          if (typeof value.root === 'string' && value.root !== '') setPath(value.root)
          const head = value.fresh === true
            ? '已新建库：结构 + 1 个示例项目 + 1 个示例人员'
            : '操作完成，只补全了缺失的目录与文件'
          setCreated((value.created ?? []).filter(item => item !== '（库根）'))
          if (value.switched === true) {
            say('ok', head + '；插件正在重启，稍后刷新面板即可看到')
          } else {
            await refresh()
            if (typeof onChanged === 'function') onChanged()
            say('ok', head)
          }
        } catch (problem) {
          say('danger', problem.message)
        } finally {
          setBusy(false)
        }
      }, [status, path, refresh, onChanged])

      const missing = status !== null && status.exists === false
      const statusColor = status === null ? T.muted : status.exists === true ? T.accent : T.danger
      const statusText = status === null
        ? '检查中…'
        : status.exists === true
          ? '库可用：' + status.root + (typeof status.notes === 'number' ? '（' + status.notes + ' 篇笔记）' : '')
          : status.missing === false
            ? '库根在，但读不到：' + (status.reason ?? '未知原因')
            : '库不存在：' + status.root
      const feedbackColor = feedback === null
        ? T.muted
        : feedback.tone === 'danger' ? T.danger : feedback.tone === 'warn' ? T.warn : T.muted

      return h('div', {
        style: { ...FONT, display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 2px', maxWidth: 560 },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, 'B2 中枢设置'),
          h('button', {
            type: 'button',
            title: '关闭设置',
            onClick: onClose,
            style: {
              ...FONT,
              fontSize: 12,
              lineHeight: '18px',
              padding: '1px 7px',
              borderRadius: 6,
              border: '1px solid ' + T.border,
              background: 'transparent',
              color: T.muted,
              cursor: 'pointer',
            },
          }, '✕')),
        h('div', { style: { fontSize: 12, color: T.muted, lineHeight: '18px' } },
          '这里决定读写哪一份 Markdown：填入已有库的路径后点「保存路径」，或填一个空目录点「初始化此库」。'),
        h('div', { style: { fontSize: 12, color: T.muted, lineHeight: '18px' } },
          '库就是普通文件夹：Obsidian 里「打开文件夹作为库」就能看到同一批文件；插件只写 Markdown，没有私有数据库。路径支持 ~/vault/B2、%USERPROFILE%\\vault\\B2。'),
        h('div', { role: 'status', style: { fontSize: 12, color: statusColor, lineHeight: '18px' } }, statusText),
        h('input', {
          type: 'text',
          value: path,
          disabled: busy,
          placeholder: '库根路径，例如 ~/vault/B2 或 %USERPROFILE%\\vault\\B2',
          onChange: event => setPath(event.target.value),
          style: {
            ...FONT,
            padding: '7px 10px',
            borderRadius: 8,
            border: '1px solid ' + T.border,
            background: T.layer1,
            color: T.text,
          },
        }),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h(Button, { onClick: pickFolder, disabled: busy }, '选择文件夹…'),
          // 库已存在时「保存路径」是主线；库不存在时「初始化」才是下一步——主次跟着状态走
          h(Button, { tone: missing ? undefined : 'primary', onClick: saveRoot, disabled: busy || path.trim() === '' }, '保存路径'),
          h(Button, { tone: missing ? 'primary' : undefined, onClick: init, disabled: busy }, '初始化此库')),
        feedback === null
          ? null
          : h('div', {
              role: feedback.tone === 'danger' ? 'alert' : 'status',
              style: { fontSize: 12, color: feedbackColor, lineHeight: '18px' },
            }, feedback.text),
        created === null || created.length === 0
          ? null
          : h('div', { style: { fontSize: 12, color: T.muted, lineHeight: '18px' } }, '创建了：' + created.join('、')))
    }

    /** 渲染出错时显示原因，而不是整块白屏。 */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error === null) return this.props.children
        return h('div', { style: { ...FONT, padding: 20, color: T.danger, lineHeight: '20px' } },
          'B2 面板出错：' + String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error))
      }
    }

    function Icon(props) {
      const size = props && props.size ? props.size : 18
      const active = props && props.active
      const color = active ? T.accent : T.muted
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        style: { display: 'block', color },
      },
        h('circle', { cx: 12, cy: 9.5, r: 3.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('circle', { cx: 5, cy: 16.5, r: 2.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('circle', { cx: 19, cy: 16.5, r: 2.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M9.2 11.4 6 14.8M14.8 11.4 18 14.8', stroke: 'currentColor', strokeWidth: 1.4, fill: 'none', strokeLinecap: 'round' }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'b2',
          order: 5,
          label: 'B2',
        }, Icon)), 'b2-hub:sidebar')
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'b2',
        }, slotProps => h(Boundary, null, h(Panel, { ...slotProps, ctx })))), 'b2-hub:page')
      },
    }
  },
})
