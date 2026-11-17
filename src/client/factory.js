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
				openCountTitle: "进行中的议题数",
				title: "Git-Bug 议题",
				refresh: "刷新",
				pull: "拉取",
				push: "推送",
				close: "关闭",
				open: "进行中",
				closed: "已关闭",
				all: "全部",
				search: "搜索标题",
				filterLabel: "按标签筛选",
				remove: "移除",
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
				openCountTitle: "Open issues",
				title: "Git-Bug issues",
				refresh: "Refresh",
				pull: "Pull",
				push: "Push",
				close: "Close",
				open: "Open",
				closed: "Closed",
				all: "All",
				search: "Search titles",
				filterLabel: "Filter by label",
				remove: "Remove",
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
			const wide = props.wide !== false
			// The plugin owns the count source and refreshes it; the renderer binds that
			// source to useOpenCount through the inject hooks compartment.
			const readCount = props.useOpenCount
			const count = typeof readCount === "function" ? readCount((value) => value) : null
			const title = wide && count !== null
				? t("title") + " · " + t("openCountTitle") + ": " + String(count)
				: t("title")
			return h("button", {
				type: "button",
				className: "gb-action",
				title,
				"aria-label": title,
				onClick: () => props.show(),
			},
				h(IconIssues, null),
				wide ? h("span", { className: "gb-action-label" }, label) : null,
				wide && count !== null ? h("span", { className: "gb-action-count" }, String(count)) : null
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
							list: "gb-label-options",
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
			const suggestions = props.suggestions ?? []
			const current = labels.split(",").map((value) => value.trim()).filter((value) => value.length > 0)
			const toggle = (label) => {
				setLabels((current.includes(label)
					? current.filter((value) => value !== label)
					: [...current, label]).join(", "))
			}
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
				h("input", { className: "gb-input", list: "gb-label-options", placeholder: t("issueLabels"), value: labels, onChange: (event) => setLabels(event.target.value) }),
				suggestions.length === 0 ? null : h("div", { className: "gb-suggests" },
					suggestions.map((value) => h("button", {
						key: value,
						type: "button",
						className: "gb-chip" + (current.includes(value) ? " gb-chip-on" : ""),
						onClick: () => toggle(value),
					}, value))
				),
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
			const [labelFilters, setLabelFilters] = react.useState([])
			const [creating, setCreating] = react.useState(false)
			const [busy, setBusy] = react.useState(false)
			const [error, setError] = react.useState(null)
			const [note, setNote] = react.useState(null)

			const report = (failure) => setError(failure instanceof Error ? failure.message : String(failure))

			const load = react.useCallback((nextStatus, nextQuery, nextLabels) => {
				setError(null)
				const params = new URLSearchParams()
				if (nextStatus !== "all") params.set("status", nextStatus)
				// Search text is literal: every word becomes one title term, so this box can
				// never turn into git-bug's query language. Only the tools accept a query.
				for (const term of nextQuery.trim().split(/\s+/).filter((value) => value.length > 0)) params.append("search", term)
				for (const label of nextLabels) params.append("label", label)
				return Promise.all([props.loadOverview(), api("/issues?" + params.toString())])
					.then(([head, body]) => {
						setOverview(head)
						setList(body.issues)
					})
					.catch(report)
			}, [])

			react.useEffect(() => { void load(status, query, labelFilters) }, [load, status, query, labelFilters])

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
						return load(status, query, labelFilters)
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
					.then(() => Promise.all([api("/issues/" + encodeURIComponent(selected)), load(status, query, labelFilters)]))
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
					.then((result) => { setNote(t("syncDone") + ": " + result.direction); return load(status, query, labelFilters) })
					.catch(report)
					.finally(() => setBusy(false))
			}

			const chips = ["open", "closed", "all"].map((value) => h("button", {
				key: value,
				type: "button",
				className: "gb-chip" + (status === value ? " gb-chip-on" : ""),
				onClick: () => setStatus(value),
			}, t(value)))

			// Configured vocabulary leads; the repository's own labels follow, so the
			// pickers reflect what is really in use — legacy and ad-hoc labels included.
			const vocabulary = overview != null && overview.labelVocabulary != null
				? { suggestions: [...new Set([...(overview.labelVocabulary.suggestions ?? []), ...(overview.labelsInUse ?? [])])] }
				: null
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
						h("button", { type: "button", className: "gb-btn", disabled: busy, onClick: () => load(status, query, labelFilters) }, t("refresh")),
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
								h("div", { className: "gb-search" },
									h("input", {
										className: "gb-input",
										placeholder: t("search"),
										value: query,
										onChange: (event) => setQuery(event.target.value),
									}),
									h("select", {
										className: "gb-input gb-select",
										value: "",
										"aria-label": t("filterLabel"),
										onChange: (event) => {
											const value = event.target.value
											if (value.length === 0 || labelFilters.includes(value)) return
											setLabelFilters([...labelFilters, value])
										},
									},
										h("option", { value: "" }, t("filterLabel")),
										(vocabulary == null ? [] : vocabulary.suggestions).map((value) => h("option", { key: value, value }, value))
									)
								),
								labelFilters.length === 0 ? null : h("div", { className: "gb-filters" },
									labelFilters.map((value) => h("button", {
										key: value,
										type: "button",
										className: "gb-chip gb-chip-on",
										title: t("remove"),
										onClick: () => setLabelFilters(labelFilters.filter((candidate) => candidate !== value)),
									}, value + " ×")))
							),
							h("datalist", { id: "gb-label-options" },
								(vocabulary == null ? [] : vocabulary.suggestions).map((value) => h("option", { key: value, value }))
							),
							creating ? h(CreateForm, { busy, onCreate: create, onClose: () => setCreating(false), suggestions: vocabulary == null ? [] : vocabulary.suggestions }) : null,
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
			return visible ? h(Panel, { hide: props.hide, loadOverview: props.loadOverview }) : null
		}

		/**
		 * Minimal observable source (getSnapshot/subscribe) with a setter that
		 * publishes only real transitions. The renderer binds these to hooks.
		 */
		function createObservable(initial) {
			let value = initial
			const listeners = new Set()
			return {
				getSnapshot: () => value,
				subscribe: (listener) => {
					listeners.add(listener)
					return () => { listeners.delete(listener) }
				},
				set: (next) => {
					if (Object.is(next, value)) return
					value = next
					for (const listener of listeners) listener()
				},
			}
		}

		/** Panel visibility, as data plus callbacks. */
		function createVisibility() {
			const source = createObservable(false)
			return {
				getSnapshot: source.getSnapshot,
				subscribe: source.subscribe,
				show: () => source.set(true),
				hide: () => source.set(false),
			}
		}

		/** How often the sidebar count re-reads the repository while the page is open. */
		const COUNT_POLL_MS = 30000


		function apply(ctx) {
			const style = document.createElement("style")
			style.dataset.plugin = STYLE_ID
			style.textContent = CSS
			document.head.appendChild(style)
			ctx.effect(() => () => { style.remove() }, "dsh-git-bug: styles")

			const visibility = createVisibility()
			// The open-issue count is a registrant-private reactive fact: the panel and the
			// sidebar badge read it through hooks, and this closure is the only writer.
			const openCount = createObservable(null)

			/** Read the overview and publish its open-issue count; the panel reuses it. */
			const loadOverview = () => api("/overview").then((overview) => {
				const open = overview == null ? undefined : overview.counts == null ? undefined : overview.counts.open
				openCount.set(typeof open === "number" ? open : null)
				return overview
			}).catch((error) => {
				openCount.set(null)
				throw error
			})

			ctx.effect(() => {
				loadOverview().catch(() => {})
				const timer = setInterval(() => { loadOverview().catch(() => {}) }, COUNT_POLL_MS)
				// Opening and closing the panel bracket every write, so one refresh on each
				// transition keeps the badge current without per-mutation wiring.
				const stopWatching = visibility.subscribe(() => { loadOverview().catch(() => {}) })
				return () => {
					clearInterval(timer)
					stopWatching()
				}
			}, "dsh-git-bug: open issue count")

			const injected = () => ({
				hooks: { visibility, openCount },
				show: visibility.show,
				hide: visibility.hide,
				loadOverview,
			})

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
