/**
 * dsh-approval-card 的组合包入口。
 *
 * 在审批瀑布上抢最前，把「这次要动哪里、做什么」压进 `displayReason.zh`。
 * 只看不改：不返回审批结果、不消费请求，永远 `return next()` —— 真正决定放不放行的是
 * 审批门与宿主应答者，本插件只负责让人看清卡片上写的是什么。
 */
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { applySummaryText, DISPLAY_BREAK, markRepeatOrdinal } from './text.mjs'

/** 活动日志超过这个字节数就轮转。 */
const LOG_LIMIT = 512 * 1024
/** 轮转后保留的行数。 */
const LOG_KEEP_LINES = 200
/** callId → 已经流到本插件的审批请求数；只用来给重复卡片编号，不参与任何判断。 */
const seenAsks = new Map()
/** 计数表上限；长会话里 callId 只增不减，超出就丢最早的。 */
const SEEN_LIMIT = 256

/**
 * 本次审批是同一调用上的第几个请求。
 *
 * 只数「真的流到本插件」的请求：被上游直接答掉的请求到不了这里，用户也看不到它的卡，
 * 数进来只会凭空多出一个编号。
 * @param {unknown} callId 审批请求的 callId。
 * @returns {number} 从 1 开始的序号。
 */
function nextAskOrdinal(callId) {
	if (callId === undefined || callId === null) return 1
	const key = String(callId)
	const ordinal = (seenAsks.get(key) ?? 0) + 1
	seenAsks.set(key, ordinal)
	if (seenAsks.size > SEEN_LIMIT) {
		for (const stale of seenAsks.keys()) {
			if (seenAsks.size <= SEEN_LIMIT) break
			// 刚写入的这条要保持有效：它的插入顺序可能最靠前（同 callId 反复审批）。
			if (stale === key) continue
			seenAsks.delete(stale)
		}
	}
	return ordinal
}

/**
 * 读会话事件列表。Session 的公开入口是 `snapshotEvents()` / `ownEvents()`，没有 `events` 字段
 * （与 dsh-approval-gate 的做法一致，纯读取，失败即当空）。
 * @param {object|null|undefined} session 会话实例。
 * @returns {Array} 事件数组。
 */
function sessionEvents(session) {
	if (!session || typeof session !== 'object') return []
	for (const method of ['snapshotEvents', 'ownEvents']) {
		if (typeof session[method] !== 'function') continue
		try {
			const events = session[method]()
			if (Array.isArray(events)) return events
		} catch {
			// 换下一个入口
		}
	}
	return Array.isArray(session.events) ? session.events : []
}

/** 把 tool/call 事件的 arguments 解析成对象。 */
function parseArgs(data) {
	const raw = data?.arguments
	try {
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
		return parsed !== null && typeof parsed === 'object' ? parsed : null
	} catch {
		return null
	}
}

/** 解析会话工作目录（拿不到时为空串）。 */
function sessionCwd(session) {
	try {
		const header = session?.header
		if (typeof header?.cwd === 'string' && header.cwd !== '') return header.cwd
		if (typeof session?.cwd === 'string' && session.cwd !== '') return session.cwd
	} catch {
		// 取不到就当没有
	}
	return ''
}

/**
 * 找本次调用（或最近一次同名调用）的工具参数。
 * 提权重试的调用有时还没进入审批处理器看到的会话视图，所以保留同名回溯兜底。
 * @param {object} req 审批请求。
 * @returns {{args: object|null, argsSource: 'callId'|'lastSameTool'|'none'}} 参数与来源。
 */
function toolCallArgs(req) {
	try {
		const events = sessionEvents(req?.agent?.session)
		if (events.length === 0) return { args: null, argsSource: 'none' }
		const callId = req?.callId
		if (callId !== undefined) {
			for (const ev of events) {
				if (ev?.type !== 'tool/call' || ev.data?.callId !== callId) continue
				const args = parseArgs(ev.data)
				if (args !== null) return { args, argsSource: 'callId' }
			}
		}
		const name = String(req?.toolName ?? '')
		for (let i = events.length - 1; i >= 0; i -= 1) {
			const ev = events[i]
			if (ev?.type !== 'tool/call' || ev.data === undefined) continue
			if (name !== '' && String(ev.data.name ?? '') !== name) continue
			const args = parseArgs(ev.data)
			if (args !== null) return { args, argsSource: 'lastSameTool' }
		}
	} catch {
		// 参数解析失败只是总结不够具体，不影响改写本身。
	}
	return { args: null, argsSource: 'none' }
}

export default {
	name: 'dsh-approval-card',

	apply(ctx) {
		// 指纹：写清本次是从哪个文件加载的 —— 排查「线上跑的是不是最新代码」用。
		trace(`apply ${import.meta.url}`)
		// prepend 是必须的：审批瀑布上任何一个监听器返回结果就结束整条链，而真正弹卡的
		// 应答者由更早挂载的组合包注册 —— 普通追加的监听器排在他后面，永远看不到要弹卡的请求
		// （dsh-approval-gate 用同一个 prepend 抢最前，原因相同）。
		ctx.on('approval/request', async (req, next) => {
			try {
				if (req !== null && typeof req === 'object') {
					const { args, argsSource } = toolCallArgs(req)
					const ordinal = nextAskOrdinal(req.callId)
					let zh = applySummaryText(req, {
						args,
						argsSource,
						cwd: sessionCwd(req.agent?.session),
						env: process.env
					})
					// 一次调用可能被问两次（审批门放行 → 工具再要更大权限）：第二张卡明确写出
					// 自己是第几个，否则两张文案不同的卡看起来像两件不相干的事。
					// 本次没改写（文案已经合规、或上游已经写过）时也有卡要显示，同样标序号。
					const base = zh !== ''
						? zh
						: (typeof req.displayReason?.zh === 'string' ? req.displayReason.zh : '')
					const marked = base === '' ? '' : markRepeatOrdinal(base, ordinal)
					if (marked !== base) {
						req.displayReason = Object.assign({}, req.displayReason, { zh: marked })
						zh = marked
					}
					if (zh !== '') {
						trace(`rewrite: ${zh.split(DISPLAY_BREAK).map((line) => line.trim()).filter(Boolean).join(' / ')}`)
					}
				}
			} catch (error) {
				// 展示文案改写失败绝不能影响审批本身：按原文继续，由下游应答者作答。
				console.error('[dsh-approval-card] 改写审批文案失败，按原文继续', error)
			}
			return next()
		}, { prepend: true })
	}
}

/**
 * 把一次活动记到插件目录的 `.activity.log`。
 * 插件挂载与改写都没有界面，这个文件是「插件是否真的在工作」的唯一外部证据：
 * 出现 `apply` 行 = 运行中的 DSH 已加载本插件；出现 `rewrite:` 行 = 真的改写过文案。
 * 日志超过 `LOG_LIMIT` 就只保留最后 `LOG_KEEP_LINES` 行 —— 它只用于排障，不该无限长。
 * @param {string} note 活动说明。
 */
function trace(note) {
	try {
		const file = new URL('../.activity.log', import.meta.url)
		appendFileSync(file, `${new Date().toISOString()} ${note}\n`)
		if (statSync(file).size > LOG_LIMIT) {
			const kept = readFileSync(file, 'utf8').split('\n').slice(-LOG_KEEP_LINES).join('\n')
			writeFileSync(file, kept.endsWith('\n') ? kept : `${kept}\n`)
		}
	} catch {
		// 写不进去（目录只读等）不影响插件功能。
	}
}
