		// dsh-git-bug browser half: an Issues panel in the web client.
		// Registered through the slot system: one sidebar footer action opens one
		// shell overlay. All data comes from the plugin's own JSON API (`/git-bug/v1`),
		// so the panel needs no RPC plumbing and renders repository truth directly.
		const react = require("react")
		const h = react.createElement

		const API_BASE = "/git-bug/v1"
		const STYLE_ID = "dsh-git-bug"

		const STRINGS = {
			zh: {
				issues: "议题",
				title: "Git-Bug 议题",
				refresh: "刷新",
				pull: "拉取",
				push: "推送",
				close: "关闭",
				open: "进行中",
				closed: "已关闭",
				all: "全部",
				search: "搜索标题与评论",
				noIssues: "没有匹配的议题",
				pickIssue: "选择左侧议题查看详情",
				newIssue: "新建议题",
				cancel: "取消",
				create: "创建",
				issueTitle: "标题",
				issueBody: "描述（计划、验收标准）",
				issueLabels: "标签，用逗号分隔",
				addComment: "添加评论",
				commentPlaceholder: "进度、决定、阻塞…",
				reopen: "重新打开",
				markClosed: "标记完成",
				syncDone: "同步完成",
				identity: "身份",
				noIdentity: "尚未创建身份",
				loading: "正在读取议题…",
				commentCount: "{n} 条评论",
				unavailable: "git-bug 不可用",
				firstWrite: "首次写入会创建身份",
				labels: "标签",
				author: "作者",
				updated: "更新",
				comments: "评论",
			},
			en: {
				issues: "Issues",
				title: "Git-Bug issues",
				refresh: "Refresh",
				pull: "Pull",
				push: "Push",
				close: "Close",
				open: "Open",
				closed: "Closed",
				all: "All",
				search: "Search titles and comments",
				noIssues: "No issues match",
				pickIssue: "Select an issue to read it",
				newIssue: "New issue",
				cancel: "Cancel",
				create: "Create",
				issueTitle: "Title",
				issueBody: "Body (plan, acceptance criteria)",
				issueLabels: "Labels, comma separated",
				addComment: "Add comment",
				commentPlaceholder: "Progress, decisions, blockers…",
				reopen: "Reopen",
				markClosed: "Mark done",
				syncDone: "Sync finished",
				identity: "Identity",
				noIdentity: "No identity yet",
				loading: "Reading issues…",
				commentCount: "{n} comments",
				unavailable: "git-bug is unavailable",
				firstWrite: "the first write creates one",
				labels: "Labels",
				author: "Author",
				updated: "Updated",
				comments: "Comments",
			},
		}

		const LANG = typeof navigator !== "undefined" && /^zh/i.test(navigator.language ?? "") ? "zh" : "en"

		function t(key, values) {
			const table = STRINGS[LANG]
			const raw = table[key] ?? STRINGS.en[key] ?? key
			if (values === undefined) return raw
			return raw.replace(/\{(\w+)\}/g, (match, name) => (values[name] === undefined ? match : String(values[name])))
		}

		/** Call the plugin API and unwrap its JSON, or throw the server's message. */
		async function api(path, options) {
			const response = await fetch(API_BASE + path, {
				...options,
				headers: { accept: "application/json", ...(options && options.body !== undefined ? { "content-type": "application/json" } : {}), ...(options == null ? void 0 : options.headers) },
			})
			let payload = null
			try {
				payload = await response.json()
			} catch (error) {
				if (response.ok) throw new Error("the plugin returned a non-JSON response")
				throw new Error("HTTP " + response.status)
			}
			if (!response.ok) {
				const message = payload && typeof payload.error === "string" ? payload.error : "HTTP " + response.status
				const failure = new Error(message)
				failure.kind = payload == null ? void 0 : payload.kind
				throw failure
			}
			return payload
		}

		function stamp(value) {
			if (value == null || typeof value.time !== "string") return ""
			return value.time.slice(0, 16).replace("T", " ")
		}

		function IconIssues(props) {
			const size = props.size ?? 16
			return h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
				h("path", { d: "M3 2.5h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z", stroke: "currentColor", strokeWidth: "1.2" }),
				h("path", { d: "M5 5.5h6M5 8h6M5 10.5h3", stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round" })
			)
		}

		function Label(props) {
			return h("span", { className: "gb-label" }, props.children)
		}

		/** Sidebar footer entry point: one button that opens the overlay. */
		function FooterAction(props) {
			const label = t("issues")
			return h("button", {
				type: "button",
				className: "gb-action",
				title: t("title"),
				"aria-label": t("title"),
				onClick: () => props.show(),
			},
				h(IconIssues, null),
				props.wide === false ? null : h("span", null, label)
			)
		}

		/** One issue row in the list. */
		function IssueRow(props) {
			const issue = props.issue
			const labels = issue.labels.map((label) => h(Label, { key: label }, label))
			const comments = issue.comments > 0 ? h("span", null, t("commentCount", { n: issue.comments })) : null
			return h("button", {
				type: "button",
				className: "gb-row" + (props.selected ? " gb-row-on" : ""),
				onClick: () => props.onSelect(issue.humanId),
			},
				h("span", { className: "gb-dot" + (issue.status === "closed" ? " gb-dot-closed" : "") }),
				h("span", { className: "gb-row-main" },
					h("div", { className: "gb-row-title" }, issue.title),
					h("div", { className: "gb-row-sub" },
						h("span", null, issue.humanId),
						h("span", null, stamp(issue.editedAt)),
						comments,
						labels.length > 0 ? h("span", { style: { display: "inline-flex", gap: "4px" } }, labels) : null
					)
				)
			)
		}

		/** Full issue detail with its comments and the write affordances. */
		function IssueDetail(props) {
			const detail = props.detail
			const [comment, setComment] = react.useState("")
			const [label, setLabel] = react.useState("")
			const labels = detail.labels.map((value) => h(Label, { key: value }, value))
			const comments = detail.comments.map((entry, index) => h("div", { key: entry.id || String(index), className: "gb-comment" },
				h("div", { className: "gb-comment-head" }, (entry.author == null ? "" : entry.author.name + " · ") + entry.humanId),
				h("div", { className: "gb-comment-body" }, entry.message)
			))
			const submitComment = () => {
				if (comment.trim().length === 0) return
				props.onComment(comment).then(() => setComment(""))
			}
			const submitLabel = () => {
				if (label.trim().length === 0) return
				props.onLabel(label.trim()).then(() => setLabel(""))
			}
			return h("div", { className: "gb-detail" },
				h("div", { className: "gb-detail-head" },
					h("div", { className: "gb-detail-title" }, detail.title),
					h("div", { className: "gb-kv" },
						h("span", null, detail.humanId),
						h("span", null, detail.id.slice(0, 12) + "…"),
						h("span", null, detail.status === "closed" ? t("closed") : t("open")),
						h("span", null, t("author") + ": " + (detail.author == null ? "?" : detail.author.name)),
						h("span", null, t("updated") + ": " + stamp(detail.editedAt)),
						labels.length > 0 ? h("span", { style: { display: "inline-flex", gap: "4px" } }, labels) : null
					),
					h("div", { style: { display: "flex", gap: "8px", marginTop: "10px", flexWrap: "wrap" } },
						h("button", {
							type: "button",
							className: "gb-btn",
							disabled: props.busy,
							onClick: () => props.onToggleStatus(detail.status === "closed" ? "open" : "closed"),
						}, detail.status === "closed" ? t("reopen") : t("markClosed")),
						h("input", {
							className: "gb-input",
							style: { width: "180px" },
							placeholder: t("labels"),
							value: label,
							onChange: (event) => setLabel(event.target.value),
							onKeyDown: (event) => { if (event.key === "Enter") submitLabel() },
						}),
						h("button", { type: "button", className: "gb-btn", disabled: props.busy || label.trim().length === 0, onClick: submitLabel }, "+")
					)
				),
				h("div", { className: "gb-comments" }, comments.length === 0 ? h("div", { className: "gb-hint" }, t("comments") + ": 0") : comments),
				h("div", { className: "gb-compose" },
					h("textarea", {
						className: "gb-input gb-textarea",
						placeholder: t("commentPlaceholder"),
						value: comment,
						onChange: (event) => setComment(event.target.value),
					}),
					h("div", null, h("button", {
						type: "button",
						className: "gb-btn gb-btn-primary",
						disabled: props.busy || comment.trim().length === 0,
						onClick: submitComment,
					}, t("addComment")))
				)
			)
		}

		/** Create form. */
		function CreateForm(props) {
			const [title, setTitle] = react.useState("")
			const [message, setMessage] = react.useState("")
			const [labels, setLabels] = react.useState("")
			const submit = () => {
				if (title.trim().length === 0) return
				const list = labels.split(",").map((value) => value.trim()).filter((value) => value.length > 0)
				props.onCreate({ title: title.trim(), message, labels: list }).then(() => {
					setTitle("")
					setMessage("")
					setLabels("")
				})
			}
			return h("div", { className: "gb-form" },
				h("input", { className: "gb-input", placeholder: t("issueTitle"), value: title, onChange: (event) => setTitle(event.target.value) }),
				h("textarea", { className: "gb-input gb-textarea", placeholder: t("issueBody"), value: message, onChange: (event) => setMessage(event.target.value) }),
				h("input", { className: "gb-input", placeholder: t("issueLabels"), value: labels, onChange: (event) => setLabels(event.target.value) }),
				h("div", { style: { display: "flex", gap: "8px" } },
					h("button", { type: "button", className: "gb-btn gb-btn-primary", disabled: props.busy || title.trim().length === 0, onClick: submit }, t("create")),
					h("button", { type: "button", className: "gb-btn", onClick: props.onClose }, t("cancel"))
				)
			)
		}

		/** The dashboard itself: filters, list, detail, sync. */
		function Panel(props) {
			const [overview, setOverview] = react.useState(null)
			const [list, setList] = react.useState(null)
			const [detail, setDetail] = react.useState(null)
			const [selected, setSelected] = react.useState(null)
			const [status, setStatus] = react.useState("open")
			const [query, setQuery] = react.useState("")
			const [creating, setCreating] = react.useState(false)
			const [busy, setBusy] = react.useState(false)
			const [error, setError] = react.useState(null)
			const [note, setNote] = react.useState(null)

			const report = (failure) => setError(failure instanceof Error ? failure.message : String(failure))

			const load = react.useCallback((nextStatus, nextQuery) => {
				setError(null)
				const params = new URLSearchParams()
				if (nextStatus !== "all") params.set("status", nextStatus)
				if (nextQuery.trim().length > 0) params.set("search", nextQuery.trim())
				return Promise.all([api("/overview"), api("/issues?" + params.toString())])
					.then(([head, body]) => {
						setOverview(head)
						setList(body.issues)
					})
					.catch(report)
			}, [])

			react.useEffect(() => { void load(status, query) }, [load, status, query])

			react.useEffect(() => {
				if (selected === null) return
				let cancelled = false
				api("/issues/" + encodeURIComponent(selected))
					.then((value) => { if (!cancelled) setDetail(value) })
					.catch(report)
				return () => { cancelled = true }
			}, [selected])

			react.useEffect(() => {
				const onKey = (event) => { if (event.key === "Escape") props.hide() }
				window.addEventListener("keydown", onKey)
				return () => window.removeEventListener("keydown", onKey)
			}, [props.hide])

			const start = () => {
				setBusy(true)
				setError(null)
				setNote(null)
				return Promise.resolve()
			}

			const create = (input) => {
				return start().then(() => api("/issues", { method: "POST", body: JSON.stringify(input) }))
					.then((created) => {
						setCreating(false)
						setNote(created.humanId + " " + created.title)
						return load(status, query)
					})
					.catch(report)
					.finally(() => setBusy(false))
			}

			const comment = (message) => {
				if (selected === null) return Promise.resolve()
				return start().then(() => api("/issues/" + encodeURIComponent(selected) + "/comments", { method: "POST", body: JSON.stringify({ message }) }))
					.then(() => api("/issues/" + encodeURIComponent(selected)))
					.then((value) => { setDetail(value); setNote(t("comments") + ": " + String(value.comments.length)) })
					.catch(report)
					.finally(() => setBusy(false))
			}

			const toggleStatus = (next) => {
				if (selected === null) return Promise.resolve()
				return start().then(() => api("/issues/" + encodeURIComponent(selected) + "/status", { method: "POST", body: JSON.stringify({ status: next }) }))
					.then(() => Promise.all([api("/issues/" + encodeURIComponent(selected)), load(status, query)]))
					.then(([value]) => { setDetail(value); setNote(value.humanId + " " + value.status) })
					.catch(report)
					.finally(() => setBusy(false))
			}

			const addLabel = (label) => {
				if (selected === null) return Promise.resolve()
				return start().then(() => api("/issues/" + encodeURIComponent(selected) + "/labels", { method: "POST", body: JSON.stringify({ label, action: "add" }) }))
					.then(() => api("/issues/" + encodeURIComponent(selected)))
					.then((value) => { setDetail(value); setNote("+" + label) })
					.catch(report)
					.finally(() => setBusy(false))
			}

			const sync = (action) => {
				return start().then(() => api("/sync", { method: "POST", body: JSON.stringify({ action }) }))
					.then((result) => { setNote(t("syncDone") + ": " + result.direction); return load(status, query) })
					.catch(report)
					.finally(() => setBusy(false))
			}

			const chips = ["open", "closed", "all"].map((value) => h("button", {
				key: value,
				type: "button",
				className: "gb-chip" + (status === value ? " gb-chip-on" : ""),
				onClick: () => setStatus(value),
			}, t(value)))

			const counts = overview === null ? "" : overview.counts.open + " " + t("open").toLowerCase() + " · " + overview.counts.closed + " " + t("closed").toLowerCase()
			const identity = overview == null ? null : overview.identity
			const identityText = overview == null ? "" : identity == null ? t("noIdentity") + " (" + t("firstWrite") + ")" : identity.name + " (" + identity.humanId + ")"
			const unavailable = overview != null && overview.availability != null && overview.availability.available === false
			const rows = (list ?? []).map((issue) => h(IssueRow, { key: issue.id, issue, selected: issue.humanId === selected, onSelect: setSelected }))

			return h("div", { className: "gb-overlay", role: "dialog", "aria-modal": "true", "aria-label": t("title") },
				h("div", { className: "gb-panel" },
					h("div", { className: "gb-head" },
						h(IconIssues, { size: 18 }),
						h("div", { style: { minWidth: 0 } },
							h("div", { className: "gb-title" }, t("title")),
							h("div", { className: "gb-meta" }, [counts, identityText, overview == null ? "" : overview.repoPath].filter((value) => value.length > 0).join(" · "))
						),
						h("div", { className: "gb-spacer" }),
						h("button", { type: "button", className: "gb-btn", disabled: busy, onClick: () => load(status, query) }, t("refresh")),
						h("button", { type: "button", className: "gb-btn", disabled: busy, onClick: () => sync("pull") }, t("pull")),
						h("button", { type: "button", className: "gb-btn", disabled: busy, onClick: () => sync("push") }, t("push")),
						h("button", { type: "button", className: "gb-btn", onClick: props.hide }, t("close"))
					),
					unavailable ? h("div", { className: "gb-error" }, t("unavailable") + ": " + String(overview.availability.reason ?? "")) : null,
					error === null ? null : h("div", { className: "gb-error" }, error),
					note === null ? null : h("div", { className: "gb-meta", style: { padding: "6px 16px" } }, note),
					h("div", { className: "gb-body" },
						h("div", { className: "gb-list" },
							h("div", { className: "gb-tools" },
								h("div", { className: "gb-filters" },
									chips,
									h("div", { className: "gb-spacer" }),
									h("button", { type: "button", className: "gb-btn gb-btn-primary", onClick: () => setCreating(!creating) }, creating ? t("cancel") : "+ " + t("newIssue"))
								),
								h("input", {
									className: "gb-input",
									placeholder: t("search"),
									value: query,
									onChange: (event) => setQuery(event.target.value),
								})
							),
							creating ? h(CreateForm, { busy, onCreate: create, onClose: () => setCreating(false) }) : null,
							h("div", { className: "gb-rows" },
								list === null ? h("div", { className: "gb-empty" }, t("loading")) : rows.length === 0 ? h("div", { className: "gb-empty" }, t("noIssues")) : rows
							)
						),
						detail !== null && detail.humanId === selected
							? h(IssueDetail, { detail, busy, onComment: comment, onToggleStatus: toggleStatus, onLabel: addLabel })
							: h("div", { className: "gb-empty" }, t("pickIssue"))
					)
				)
			)
		}

		/** Overlay entry point: renders nothing while the panel is closed. */
		function Overlay(props) {
			const visible = props.useVisibility((value) => value)
			return visible ? h(Panel, { hide: props.hide }) : null
		}

		/** Minimal observable source the renderer binds to `useVisibility`. */
		function createVisibility() {
			let visible = false
			const listeners = new Set()
			const publish = () => { for (const listener of listeners) listener() }
			return {
				getSnapshot: () => visible,
				subscribe: (listener) => {
					listeners.add(listener)
					return () => { listeners.delete(listener) }
				},
				show: () => { if (!visible) { visible = true; publish() } },
				hide: () => { if (visible) { visible = false; publish() } },
			}
		}

		const CSS = ".gb-action{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:3px 6px;border:0;border-radius:6px;background:0 0;color:var(--dsw-alias-label-tertiary,#8b8b8b);cursor:pointer;font-size:12px;line-height:18px}\n.gb-action:hover,.gb-action:focus-visible{color:var(--dsw-alias-label-secondary,#b0b0b0);background:var(--dsw-alias-fill-l1,rgba(255,255,255,.06))}\n.gb-action svg{flex:none}\n.gb-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.45)}\n.gb-panel{display:flex;flex-direction:column;width:min(1080px,100%);height:min(760px,100%);overflow:hidden;border:1px solid var(--dsw-alias-border-l2,#333);border-radius:14px;background:var(--dsw-specific-menu,#1b1b1f);color:var(--dsw-alias-label-primary,#eee);box-shadow:0 24px 64px rgba(0,0,0,.45)}\n.gb-head{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#333)}\n.gb-title{font-size:15px;font-weight:600}\n.gb-meta{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b8b8b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.gb-spacer{flex:1}\n.gb-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2,#3a3a40);border-radius:8px;background:0 0;color:inherit;cursor:pointer;font-size:12px}\n.gb-btn:hover:not(:disabled){background:var(--dsw-alias-fill-l1,rgba(255,255,255,.07))}\n.gb-btn:disabled{opacity:.5;cursor:default}\n.gb-btn-primary{background:var(--dsw-alias-button-primary-fill,#4a6cf7);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}\n.gb-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#3a5be0)}\n.gb-body{display:flex;flex:1;min-height:0}\n.gb-list{display:flex;flex-direction:column;width:46%;min-width:320px;border-right:1px solid var(--dsw-alias-border-l2,#333)}\n.gb-tools{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#2b2b30)}\n.gb-filters{display:flex;gap:6px;flex-wrap:wrap}\n.gb-chip{padding:3px 10px;border:1px solid var(--dsw-alias-border-l2,#3a3a40);border-radius:999px;background:0 0;color:inherit;cursor:pointer;font-size:12px}\n.gb-chip-on{background:var(--dsw-alias-fill-l2,rgba(255,255,255,.12));border-color:var(--dsw-alias-border-l3,#555)}\n.gb-input{width:100%;box-sizing:border-box;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2,#3a3a40);border-radius:8px;background:var(--dsw-specific-input,rgba(0,0,0,.25));color:inherit;font:inherit;font-size:12px}\n.gb-input:focus{outline:1px solid var(--dsw-alias-brand-primary,#4a6cf7)}\n.gb-rows{flex:1;overflow:auto}\n.gb-row{display:flex;gap:8px;align-items:flex-start;width:100%;padding:9px 12px;border:0;border-bottom:1px solid var(--dsw-alias-border-l2,#28282d);background:0 0;color:inherit;cursor:pointer;text-align:left;font:inherit}\n.gb-row:hover{background:var(--dsw-alias-fill-l1,rgba(255,255,255,.05))}\n.gb-row-on{background:var(--dsw-alias-fill-l2,rgba(255,255,255,.1))}\n.gb-dot{flex:none;width:8px;height:8px;margin-top:5px;border-radius:50%;background:#46c07a}\n.gb-dot-closed{background:#8b8b8b}\n.gb-row-main{flex:1;min-width:0}\n.gb-row-title{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.gb-row-sub{display:flex;gap:8px;margin-top:3px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8b8b)}\n.gb-label{padding:0 6px;border-radius:999px;background:var(--dsw-alias-fill-l2,rgba(255,255,255,.1));font-size:10px}\n.gb-detail{display:flex;flex-direction:column;flex:1;min-width:0;overflow:auto}\n.gb-detail-head{padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#2b2b30)}\n.gb-detail-title{font-size:14px;font-weight:600}\n.gb-kv{margin-top:6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8b8b);display:flex;gap:10px;flex-wrap:wrap}\n.gb-comments{display:flex;flex-direction:column;gap:10px;padding:14px 16px}\n.gb-comment{padding:9px 11px;border:1px solid var(--dsw-alias-border-l2,#2b2b30);border-radius:10px;background:rgba(255,255,255,.02)}\n.gb-comment-head{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8b8b);margin-bottom:4px}\n.gb-comment-body{font-size:12px;white-space:pre-wrap;word-break:break-word}\n.gb-compose{display:flex;flex-direction:column;gap:8px;padding:0 16px 16px}\n.gb-textarea{min-height:84px;resize:vertical;font-family:inherit}\n.gb-empty{display:flex;flex:1;align-items:center;justify-content:center;padding:24px;color:var(--dsw-alias-label-tertiary,#8b8b8b);font-size:12px;text-align:center}\n.gb-error{margin:10px 16px;padding:8px 10px;border:1px solid #b4453f;border-radius:8px;background:rgba(180,69,63,.12);font-size:12px;white-space:pre-wrap}\n.gb-form{display:flex;flex-direction:column;gap:8px;padding:12px;border-bottom:1px solid var(--dsw-alias-border-l2,#2b2b30)}\n.gb-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8b8b)}"

		function apply(ctx) {
			const style = document.createElement("style")
			style.dataset.plugin = STYLE_ID
			style.textContent = CSS
			document.head.appendChild(style)
			ctx.effect(() => () => { style.remove() }, "dsh-git-bug: styles")

			const visibility = createVisibility()
			const injected = () => ({ hooks: { visibility }, show: visibility.show, hide: visibility.hide })

			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "git-bug",
				order: 18,
				inject: injected,
			}, FooterAction))

			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "git-bug",
				order: 18,
				inject: injected,
			}, Overlay))
		}

		const inject = ["slots"]

		exports.apply = apply
		exports.inject = inject
		exports.__internals = { STRINGS, LANG, t, createVisibility, api, stamp }
