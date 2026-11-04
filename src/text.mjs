/**
 * 审批卡文案：把「这次到底要动哪里、做什么」压成中文前两行，并保留下游给出的拦截理由。
 *
 * 纯函数模块，不碰 I/O、不读会话 —— 会话取事件的部分在 index.mjs。
 * 单独成文件是为了能直接 `node --test` 覆盖，不必起 DSH。
 *
 * 关键设计取舍（详见 README）：
 *   · 目标取「真实调用参数」：`file_path` 原文，或命令里带引号的整段路径；
 *     命令里的路径**不在空白处切断**（`D:\DeepSeek Harness工作目录\…` 这类目录名带空格）。
 *   · 路径几乎不截断（上限 240）：卡片正文可换行、可滚动，看不见完整路径等于没显示。
 *   · 只改 `displayReason`，**绝不改 `req.reason`** —— 上游（审批门/宿主）拿它做判定与审计，
 *     改了会破坏别人的匹配逻辑；而卡片标题优先读 `displayReason`，改这一处就够。
 */

/** 沙箱模式标识 → 中文名。 */
export const MODE_LABELS = new Map([
	['danger-full-access', '完全访问（不受限）'],
	['workspace-write', '仅工作区可写'],
	['read-only', '只读']
])

/** 沙箱模式标识 → 范围说明（第二行用，讲清这次放开的到底是多大范围）。 */
export const MODE_SCOPE = {
	'read-only': '只读（不会修改任何文件）',
	'workspace-write': '仅工作区可写（工作区外仍被拒绝）',
	'danger-full-access': '完全访问（整机可读写、含系统位置、不可自动回滚）'
}

/** 工具名 → 操作类别（显式表优先，覆盖常见名与带命名空间的变体）。 */
const ACTION_BY_NAME = new Map([
	['write', '写入文件'], ['write_file', '写入文件'], ['create_file', '写入文件'], ['create', '写入文件'], ['new_file', '写入文件'],
	['edit', '修改文件'], ['edit_file', '修改文件'], ['str_replace_editor', '修改文件'], ['str-replace-editor', '修改文件'],
	['replace', '修改文件'], ['patch', '修改文件'], ['apply_patch', '修改文件'],
	['read', '读取'], ['read_file', '读取'], ['cat', '读取'], ['view', '读取'],
	['glob', '检索'], ['grep', '检索'], ['search', '检索'], ['ls', '检索'], ['list', '检索'],
	['pwsh', '执行命令'], ['powershell', '执行命令'], ['cmd', '执行命令'], ['bash', '执行命令'], ['sh', '执行命令'],
	['zsh', '执行命令'], ['exec', '执行命令'], ['run', '执行命令'], ['shell', '执行命令'], ['terminal', '执行命令'],
	['python', '执行命令'], ['python3', '执行命令'], ['node', '执行命令'], ['deno', '执行命令'], ['bun', '执行命令'],
	['curl', '执行命令'], ['wget', '执行命令']
])

/** 兜底用的后缀规则（表里没有的名字，按词尾猜类别）。 */
const ACTION_SUFFIXES = [
	[/(?:^|[-_])(?:write|create)$/, '写入文件'],
	[/(?:^|[-_])(?:edit|replace|patch)$/, '修改文件'],
	[/(?:^|[-_])(?:read|cat|view)$/, '读取'],
	[/(?:^|[-_])(?:search|glob|grep|ls|list)$/, '检索'],
	[/(?:^|[-_])(?:bash|sh|shell|exec|run|cmd|terminal)$/, '执行命令']
]

/** 操作类别 → 兜底的操作名（没有可识别的命令时用它）。 */
const TOOL_OPERATIONS = {
	写入文件: '写入文件',
	修改文件: '修改文件',
	读取: '读取文件',
	检索: '检索',
	执行命令: '命令执行',
	调用工具: '调用工具'
}

/**
 * 操作名 → 影响分类标签，跟在操作后面显示成 ` [ 写入 ]`。
 *   写入 = 新增/产生内容；修改 = 改动已有内容；删除 = 删掉/销毁既有内容；
 *   读取 = 不改变任何东西；执行 = 会跑东西，但影响面看不出来。
 */
const OPERATION_KINDS = {
	新建文件夹: '写入',
	新建文件: '写入',
	写入文件: '写入',
	复制: '写入',
	下载: '写入',
	安装依赖或软件: '写入',
	构建打包: '写入',
	修改文件: '修改',
	重命名: '修改',
	移动: '修改',
	修改权限或属性: '修改',
	修改注册表: '修改',
	结束进程: '修改',
	'提交 Git 变更': '修改',
	推送或发布: '修改',
	删除: '删除',
	递归删除: '删除',
	读取文件: '读取',
	检索: '读取',
	查找或读取: '读取',
	查询系统信息: '读取',
	'查看 Git 状态': '读取',
	运行程序: '执行',
	运行测试: '执行',
	命令执行: '执行',
	调用工具: '执行'
}

/** 表里没有的操作名一律按「执行」处理：确实要跑东西，但影响面说不清。 */
const DEFAULT_KIND = '执行'

/**
 * 命令关键词 → 中文操作名。排在前面的是更危险/更具体的形态（「递归删除」先于「删除」），
 * 一条命令命中多条时取第一条，宁可报更重的那个。
 */
const COMMAND_OPERATIONS = [
	[/Remove-Item\b[^\r\n]*-Recurse|(?:^|[\s;&|(])rm\s+-[a-zA-Z]*r|rmdir\s+\/s|git\s+clean\s+-[a-zA-Z]*f/i, '递归删除'],
	[/(?:^|[\s;&|(])(?:rm|del|erase|rmdir|Remove-Item)\b|git\s+reset\s+--hard|\bdrop\s+(?:table|database)\b|\btruncate\s+table\b/i, '删除'],
	[/git\s+push|gh\s+release|(?:npm|pnpm|yarn)\s+publish/i, '推送或发布'],
	[/(?:npm|pnpm|yarn|pip3?|uv|cargo|go|dotnet|winget|choco|scoop)\b[^|;&]*\b(?:install|add|i)\b/i, '安装依赖或软件'],
	[/(?:npm|pnpm|yarn)\b[^|;&]*\b(?:build|pack)\b|esbuild|webpack|vite\s+build|postject|msbuild|dotnet\s+build|cargo\s+(?:build|package)/i, '构建打包'],
	[/(?:npm|pnpm|yarn)\b[^|;&]*\btest\b|pytest|go\s+test|dotnet\s+test|vitest|jest/i, '运行测试'],
	[/(?:Set-Content|Add-Content|Out-File)\b|(?:^|[\s;&|(])echo\b[^|]*>>?/i, '写入文件'],
	[/New-Item\b[^\r\n]*-ItemType\s+Directory|(?:^|[\s;&|(])(?:mkdir|md)\b/i, '新建文件夹'],
	[/New-Item\b[^\r\n]*-ItemType\s+File|(?:^|[\s;&|(])(?:ni|touch|New-Item)\b/i, '新建文件'],
	[/Copy-Item\b|(?:^|[\s;&|(])(?:cp|copy|xcopy|robocopy)\b/i, '复制'],
	[/Rename-Item\b|(?:^|[\s;&|(])(?:ren|rename)\b/i, '重命名'],
	[/Move-Item\b|(?:^|[\s;&|(])(?:mv|move)\b/i, '移动'],
	[/curl\b|wget\b|Invoke-WebRequest|Invoke-RestMethod|git\s+clone/i, '下载'],
	[/git\s+commit/i, '提交 Git 变更'],
	[/git\s+(?:status|diff|log|show|branch)/i, '查看 Git 状态'],
	[/Start-Process|&\s*['"]?\S+\.(?:exe|cmd|bat|ps1)|node\s+\S+\.(?:js|mjs|cjs)|python3?\s+\S+\.py/i, '运行程序'],
	[/(?:Set-Acl|icacls|takeown|Set-ItemProperty\s+-Name)/i, '修改权限或属性'],
	[/reg\s+(?:add|delete|import)/i, '修改注册表'],
	[/Stop-Process|taskkill/i, '结束进程'],
	[/(?:Get-ChildItem|Select-String|Get-Content)\b|(?:^|[\s;&|(])(?:ls|dir|find|rg|grep|cat|type)\b/i, '查找或读取'],
	[/(?:Get-Process|Get-Service|Get-CimInstance|tasklist|systeminfo|Get-Item)\b/i, '查询系统信息']
]

/** 工具参数里代表「命令」的字段。 */
const COMMAND_KEYS = ['command', 'cmd', 'script', 'CommandLine']

/** 工具参数里代表「目标文件」的字段。 */
const FILE_KEYS = ['file_path', 'filePath', 'path', 'filename', 'file', 'target', 'source', 'dest', 'destination']

/** 工具参数里代表「执行目录」的字段（命令类工具用它解释相对路径）。 */
const WORKDIR_KEYS = ['workdir', 'working_directory', 'workingDirectory', 'cwd', 'directory']

/** 分类与取路径时最多看多长的命令（防止病态超长脚本拖慢；命令原文不显示在这一行）。 */
const COMMAND_SCAN_LIMIT = 2000

/**
 * 从文本里摘绝对路径：Windows 盘符、UNC、POSIX 绝对路径。
 * 排除引号与中文标点，否则「D:\a\b，还有」会被整段当成路径。
 * `(?![\\/])` 挡掉协议头被当成盘符：`http://x` 里的 `p://` 不是 `p:\` 盘符路径
 * （真实缺陷：线上卡片出现过 `对 p://127.0.0.1:43189/ 进行下载`）。
 */
const PATH_RE = /(?:[A-Za-z]:[\\/](?![\\/])|\\\\|\/)[^\s"'`,;|)>）】。，、；：！？「」『』（）【】《》]+/g

/**
 * URL：它不是文件路径，但对「要动哪里」同样关键（下载/外发/请求接口），
 * 所以单独抽出来当目标，并在跑路径正则前先按等长空白遮掉 —— 否则 `://` 会被当成盘符。
 */
const URL_RE = /\b(?:https?|ftp|wss?):\/\/[^\s"'`<>）】。，、；：！？《》]+/gi

/**
 * 引号里整段像路径的文本：`'D:\a b\c'`、`"C:\x y"`。
 * 路径本身可以带空格，PATH_RE 按空白切只能拿到第一段 —— 这是「卡片只有短短的路径」的来源之一，
 * 所以引号段必须优先整段取。
 */
const QUOTED_PATH_RE = /(['"])((?:[A-Za-z]:[\\/]|\\\\|\/)[^'"\r\n]*?)\1/g

/**
 * 展示用换行：`\n` 前面补一个空格。
 * 卡片标题的 CSS 没有 `white-space:pre-line`（`\n` 会被折叠），client.js 半边会补上这条样式；
 * 前缀那个空格是兜底：万一 client 半边没加载，折叠后也只是多一个空格，两段不会粘在一起。
 */
export const DISPLAY_BREAK = ' \n'

/** 首行最多罗列几个目标：再多就把卡片撑成一段话，超出部分用「等 N 处」收尾。 */
const TARGET_LIST_MAX = 6

/**
 * 工具名 → 操作类别。
 * 带命名空间的变体（`mcp__fs.edit_file`、`fs:write`）先取尾段再查表。
 * @param {unknown} toolName 工具名。
 * @returns {string} 操作类别中文标签。
 */
export function actionLabelFor(toolName) {
	const raw = String(toolName ?? '').trim().toLowerCase()
	if (raw === '') return '调用工具'
	const tail = raw.split(/[./:]/).pop() || raw
	for (const key of [raw, tail]) {
		const hit = ACTION_BY_NAME.get(key)
		if (hit !== undefined) return hit
	}
	for (const key of [raw, tail]) {
		const hit = ACTION_SUFFIXES.find(([re]) => re.test(key))
		if (hit !== undefined) return hit[1]
	}
	return '调用工具'
}

/**
 * 截断文本，超出时结尾加省略号。
 * @param {unknown} text 原文。
 * @param {number} max 最大长度。
 * @returns {string} 截断后的单行文本。
 */
function clipText(text, max) {
	const s = String(text ?? '').replace(/\s+/g, ' ').trim()
	return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * 截断过长路径：保留头尾，中间省略。
 * 上限给得很大：卡片正文可换行、可滚动，路径被截短就失去了「看不看得清要动哪里」的意义，
 * 只有病态长路径（深层 node_modules）才真的截断。
 * @param {string} path 原始路径。
 * @param {number} [max] 最大长度。
 * @returns {string} 截断后的路径。
 */
function clipPath(path, max = 240) {
	const s = String(path)
	if (s.length <= max) return s
	const head = Math.max(8, max - 60)
	return `${s.slice(0, head)}…${s.slice(-59)}`
}

/**
 * 把「未加引号但内部带空格」的路径接续完整（`D:\DeepSeek Harness工作目录\DeepSeek`）。
 * 只做两跳，且只在下一段明显还是同一路径时接：带分隔符，或当前还没有扩展名且不是纯中文。
 * 遇到选项（`-Force`）、操作符（`&&`）、中文标点即停。
 * @param {string} source 原文。
 * @param {number} start 已匹配路径的结束位置。
 * @param {string} head 已匹配到的路径。
 * @returns {string} 接续后的路径。
 */
function extendTail(source, start, head) {
	let path = head
	let at = start
	for (let step = 0; step < 2; step += 1) {
		const m = /^[ \t]+([^\s"'`,;|)>）】。，、；：！？「」『』（）【】《》]+)/.exec(source.slice(at))
		if (m === null) break
		const token = m[1]
		if (/^[-/]/.test(token) || /^(?:&&|\|\||[;&|])$/.test(token)) break
		const hasSep = /[\\/]/.test(token)
		const lastSegment = path.slice(path.lastIndexOf('\\') + 1)
		const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(lastSegment)
		const allCJK = /^[\u4e00-\u9fff]+$/.test(token)
		if (!hasSep && (hasExt || allCJK)) break
		path += ` ${token}`
		at += m[0].length
	}
	return path
}

/**
 * 展开命令里的环境变量引用（`$env:DSH_HOME`、`${env:DSH_HOME}`、`%DSH_HOME%`）。
 * 不展开的话，卡片会显示 `$env:DSH_HOME\profiles\…` 这种「看起来像路径、其实不能照着找」的东西
 * （线上实测有过）。取不到值时原样保留，绝不编造。
 * @param {unknown} text 含变量引用的文本。
 * @param {Record<string, string|undefined>|null|undefined} env 环境变量表（宿主传 `process.env`）。
 * @returns {string} 展开后的文本。
 */
export function expandEnvVars(text, env) {
	const source = String(text ?? '')
	if (env === null || typeof env !== 'object') return source
	return source.replace(/\$\{?env:([A-Za-z_][A-Za-z0-9_]*)\}?|%([A-Za-z_][A-Za-z0-9_]*)%/g, (all, dollar, percent) => {
		const value = env[dollar ?? percent]
		return typeof value === 'string' && value !== '' ? value : all
	})
}

/**
 * 从文本里摘出可能是「要动的位置」的路径，去重并限制条数。
 * 顺序：**引号包裹的整段路径优先**（命令里被显式当成一个参数传的，带空格也只有整段才对），
 * 再用未加引号的匹配兜底并向后接续。
 * @param {unknown} text 申请理由、命令等文本。
 * @param {number} [limit] 最多保留几条。
 * @returns {string[]} 路径列表（过长才截断）。
 */
export function extractPaths(text, limit = 2) {
	const source = String(text ?? '')
	const out = []
	const push = (raw) => {
		const path = String(raw ?? '').replace(/[.。,，、；：]+$/, '').trim()
		if (path.length < 4) return
		// 前导 `/` 的形态要求至少两段（`/tmp/x` 像路径，`工作区/工作区外` 不像），
		// 盘符与 UNC 形态天然可信，不做这个限制。
		if (path.startsWith('/') && !path.slice(1).includes('/')) return
		if (!out.includes(path)) out.push(path)
	}
	// URL 先单独收（下载/外发时它就是目标），再按等长空白遮掉，
	// 免得 `https://` 里的 `s://` 被 PATH_RE 当成「盘符 + 斜杠」的路径。
	const masked = source.replace(URL_RE, (raw) => {
		push(raw)
		return ' '.repeat(raw.length)
	})
	for (const m of masked.matchAll(QUOTED_PATH_RE)) push(m[2])
	const re = new RegExp(PATH_RE.source, 'g')
	let m
	while ((m = re.exec(masked)) !== null) {
		const path = extendTail(masked, m.index + m[0].length, m[0])
		// 已经是某条已知长路径的前缀截断（`D:\DeepSeek` vs `D:\DeepSeek Harness工作目录`）：丢掉。
		if (out.some((known) => known !== path && known.startsWith(path))) continue
		push(path)
	}
	return out.slice(0, limit).map((p) => clipPath(p))
}

/**
 * 从工具参数里取命令文本。
 * 关键：**保留换行、不折叠空白**。操作分类里的 `[^\r\n]*` 靠换行界定「同一条语句」，
 * 折叠掉换行会让 `Remove-Item …-Force` 与后面某行的 `-Recurse` 连成一条，既认错操作也取错目标。
 * @param {object|null} args 工具参数对象。
 * @returns {string} 命令原文（截到上限），取不到时为空串。
 */
function commandOf(args) {
	if (args === null || typeof args !== 'object') return ''
	for (const key of COMMAND_KEYS) {
		const value = args[key]
		if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, COMMAND_SCAN_LIMIT)
	}
	return ''
}

/**
 * 取命令里命中的那个动词所在的「一条语句」（按换行、`;`、`|` 切分）。
 * @param {string} text 命令原文。
 * @param {number} index 命中位置。
 * @returns {string} 语句片段。
 */
function statementAt(text, index) {
	let start = 0
	for (let i = index; i > 0; i -= 1) {
		if ([';', '\n', '|'].includes(text[i - 1])) {
			start = i
			break
		}
	}
	let end = text.length
	for (let i = index; i < text.length; i += 1) {
		if ([';', '\n', '|'].includes(text[i])) {
			end = i
			break
		}
	}
	return text.slice(start, end)
}

/**
 * 扫出命令里简单的变量赋值（`$dir = 'C:\x'`），供 `Join-Path`/`"$dir\y"` 解析。
 * @param {string} command 命令原文。
 * @returns {Map<string, string>} 变量名 → 字面值。
 */
function variableValues(command) {
	const vars = new Map()
	const re = /\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:'([^']*)'|"([^"]*)")/g
	let m
	while ((m = re.exec(command)) !== null) {
		const value = String(m[2] ?? m[3] ?? '').trim()
		if (value !== '') vars.set(m[1], value)
	}
	return vars
}

/**
 * 取一条语句里最像「被操作的那个东西」的路径：
 * 先解析 `Join-Path $var 'x'` 与 `"$var\x"`，再退回语句里写死的绝对路径。
 * @param {string} statement 语句片段。
 * @param {Map<string, string>} vars 变量表。
 * @returns {string[]} 路径候选（按可信度排序，未截断）。
 */
function pathsInStatement(statement, vars) {
	const out = []
	const join = (base, child) => `${String(base).replace(/[\\/]+$/, '')}\\${String(child).replace(/^[\\/]+/, '')}`
	let m
	const joinRe = /Join-Path\s+(?:-Path\s+)?\$([A-Za-z_][A-Za-z0-9_]*)\s+(?:-ChildPath\s+)?'([^']*)'/gi
	while ((m = joinRe.exec(statement)) !== null) {
		const base = vars.get(m[1])
		if (base !== undefined) out.push(join(base, m[2]))
	}
	const varPathRe = /\$([A-Za-z_][A-Za-z0-9_]*)([\\/][^\s"',;|)>）】。，、；：！？]+)/g
	while ((m = varPathRe.exec(statement)) !== null) {
		const base = vars.get(m[1])
		if (base !== undefined) out.push(`${base.replace(/[\\/]+$/, '')}${m[2]}`)
	}
	// 光用变量本身指路径：`-LiteralPath $folder`
	const bareVarRe = /\$([A-Za-z_][A-Za-z0-9_]*)\b/g
	while ((m = bareVarRe.exec(statement)) !== null) {
		const value = vars.get(m[1])
		if (value !== undefined && /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value)) out.push(value)
	}
	// `cd X && 干活`：X 只是换了工作目录，不是这次要动的东西 —— 它排在最前面，
	// 不剔掉就会把「执行目录」当成「操作目标」（线上见过：目标是工作区，真正改的是会话目录）。
	const cdTargets = new Set()
	const cdRe = /(?:^|[;&|]\s*|\s)(?:cd|chdir|set-location|push-location|pushd)\s+(?:-path\s+|-literalpath\s+)?(?:'([^']*)'|"([^"]*)"|([^\s;&|]+))/gi
	while ((m = cdRe.exec(statement)) !== null) {
		const target = String(m[1] ?? m[2] ?? m[3] ?? '').trim()
		if (target !== '') cdTargets.add(target.replace(/[\\/]+$/, '').toLowerCase())
	}
	const skip = (p) => cdTargets.has(String(p).replace(/[\\/]+$/, '').toLowerCase())
	for (const p of extractPaths(statement, 3)) {
		if (!skip(p)) out.push(p)
	}
	return out.filter((p) => !skip(p))
}

/**
 * 从工具参数里取第一个像路径的目标（结构化字段优先：它就是这次的精确目标）。
 * @param {object|null} args 工具参数对象。
 * @returns {string} 路径，取不到时为空串。
 */
function targetOf(args, env = null) {
	if (args === null || typeof args !== 'object') return ''
	for (const key of FILE_KEYS) {
		const value = args[key]
		const list = Array.isArray(value) ? value : [value]
		for (const item of list) {
			if (typeof item !== 'string') continue
			const path = expandEnvVars(item.trim(), env)
			if (path.length < 3 || (!path.includes('/') && !path.includes('\\'))) continue
			if (/^(?:https?:|data:|blob:)/i.test(path)) continue
			return clipPath(path)
		}
	}
	return ''
}

/**
 * 在命令里定位命中的操作，并取出它所在的那条语句（目标从这条语句里取）。
 * @param {string} command 命令原文。
 * @returns {{operation: string, index: number, statement: string}} 命中信息；没命中时 operation 为空串。
 */
export function matchOperation(command) {
	const text = String(command ?? '')
	if (text.trim() === '') return { operation: '', index: -1, statement: '' }
	for (const [re, operation] of COMMAND_OPERATIONS) {
		const m = re.exec(text)
		if (m === null) continue
		// 有些模式为了限定词边界会连带吃掉前一个分隔符（匹配到的是 `\nRename`），
		// 直接拿 m.index 会把「上一条语句」当命中语句；往后跳到真正的词首再取语句。
		let at = m.index
		while (at < text.length && /[\s;&|(]/.test(text[at])) at += 1
		return { operation, index: at, statement: statementAt(text, at) }
	}
	return { operation: '', index: -1, statement: '' }
}

/**
 * 判断这次要做的是什么操作（中文名）。有可识别的命令就用命令关键词判定，否则退回工具类别。
 * @param {{command?: string, toolName?: unknown}} input 命令文本与工具名。
 * @returns {string} 中文操作名。
 */
export function operationFor(input) {
	const o = input || {}
	const command = String(o.command ?? '')
	if (command.trim() !== '') return matchOperation(command).operation || '命令执行'
	return TOOL_OPERATIONS[actionLabelFor(o.toolName)] ?? '调用工具'
}

/**
 * 判断这次操作的目标（路径）。
 * 优先级：结构化文件字段 → **命中动词所在语句**里的路径 → 命令里任意位置的第一个绝对路径
 * → 申请理由里的绝对路径 → 会话工作目录。
 * @param {{args?: object|null, command?: string, statement?: string, justification?: unknown, cwd?: unknown}} input 事实。
 * @returns {string} 目标文本，取不到时为空串。
 */
export function targetFor(input) {
	const o = input || {}
	const env = o.env ?? null
	const fromArgs = targetOf(o.args ?? null, env)
	if (fromArgs !== '') return fromArgs
	const command = String(o.command ?? '')
	let statement = ''
	if (command.trim() !== '') {
		statement = typeof o.statement === 'string' && o.statement !== '' ? o.statement : matchOperation(command).statement
		const fromStatement = preferLocal(pathsInStatement(statement, variableValues(command)))
		if (fromStatement !== undefined) return clipPath(fromStatement)
		const anywhere = preferLocal(extractPaths(command, 3))
		if (anywhere !== undefined) return anywhere
	}
	const fromJustification = extractPaths(expandEnvVars(o.justification, env), 1)[0]
	if (fromJustification !== undefined) return fromJustification
	// 命令里没有任何绝对路径、说明里也没有：把命中的那条语句本身亮出来。
	// `对 命令行 node ..\audit.js --fix 进行命令执行` 比 `对 当前工作目录 X 进行…` 有用得多 ——
	// 用户要判断的是「这条命令会动什么」，工作目录只是线索。
	// 工具参数带了 workdir/cwd 时一并写出，否则相对路径落在哪个目录全靠猜。
	const fromCommand = clipText(statement, 120)
	if (fromCommand !== '') {
		const workdir = clipPath(String(workdirOf(o.args) ?? '').trim(), 160)
		return workdir === '' ? `命令行 ${fromCommand}` : `命令行 ${fromCommand}（在 ${workdir}）`
	}
	const cwd = clipPath(String(o.cwd ?? '').trim(), 160)
	return cwd === '' ? '' : `当前工作目录 ${cwd}`
}

/**
 * 取工具参数里声明的执行目录（不同工具的键名不同）。
 * @param {object|null|undefined} args 工具参数。
 * @returns {string|undefined} 执行目录原文。
 */
function workdirOf(args) {
	if (args === null || typeof args !== 'object') return undefined
	for (const key of WORKDIR_KEYS) {
		const value = args[key]
		if (typeof value === 'string' && value.trim() !== '') return value
	}
	return undefined
}

/**
 * 工具参数里所有能当目标的结构化字段值（不止第一个）。
 * @param {object|null} args 工具参数。
 * @param {object|null} env 环境变量。
 * @returns {string[]} 路径列表。
 */
function pathsOfArgs(args, env = null) {
	if (args === null || typeof args !== 'object') return []
	const out = []
	for (const key of FILE_KEYS) {
		const value = args[key]
		const list = Array.isArray(value) ? value : [value]
		for (const item of list) {
			if (typeof item !== 'string') continue
			const path = expandEnvVars(item.trim(), env)
			if (path.length < 3 || (!path.includes('/') && !path.includes('\\'))) continue
			if (/^(?:https?:|data:|blob:)/i.test(path)) continue
			out.push(path)
		}
	}
	return out
}

/**
 * 一条命令可能动的不止一个东西（`Set-Content a; Set-Content b; …`）：按
 * 「结构化字段 → 命中语句 → 命令任意位置 → 申请理由」逐层收齐，去重保序。
 *
 * 首行把每个目标都写出来，用户扫一眼就知道这次要碰几处文件；此前只写第一个，
 * 其余靠下游那行「目标含工作区外路径 N 处：…」补 —— 那行是审批门按空白截断过的，
 * 而且经常整行退化成一句没有路径的统计。
 * @param {{args?: object|null, command?: string, statement?: string, justification?: unknown, cwd?: unknown, env?: object|null}} input 事实。
 * @returns {string[]} 目标列表（已去重，可能为空）。
 */
/**
 * 脚本里的变量引用与格式串，长得像路径但不是这次要动的文件：
 * `\\?\$p`（设备前缀 + 变量）、`C:\tmp exists={0}`（格式化字符串）。
 */
const JUNK_PATH_RE = /[$%{}]|^\\\\\?\\/

export function targetListFor(input) {
	const o = input || {}
	const env = o.env ?? null
	const seen = new Set()
	const out = []
	const push = (value) => {
		const raw = String(value ?? '').trim()
		// `\\?\$p`、`C:\tmp exists={0}` 这类是脚本里的变量引用和格式串，不是这次要动的文件。
		if (JUNK_PATH_RE.test(raw)) return
		const path = clipPath(raw)
		if (path === '') return
		const key = path.toLowerCase()
		if (seen.has(key)) return
		seen.add(key)
		out.push(path)
	}
	// 子路径已经说明同一件事时，上级目录不再单列（`C:\tmp` 之于 `C:\tmp\x.txt`）。
	const finish = () =>
		out.filter((path) => {
			const prefix = `${path.replace(/[\\/]+$/, '').toLowerCase()}\\`
			return !out.some((other) => other !== path && other.toLowerCase().startsWith(prefix))
		})
	for (const path of pathsOfArgs(o.args ?? null, env)) push(path)
	if (out.length > 0) return finish()
	const command = String(o.command ?? '')
	if (command.trim() !== '') {
		// 一条命令常由几条语句拼出来（`Set-Content a; Set-Content b; …`）：只取「命中动词」那一条
		// 语句，首行就只写得出第一处，剩下的靠下游统计补 —— 而下游那行是门按空白截断过的。
		// 逐段取，去重后全部进首行。
		const vars = variableValues(command)
		const segments = command
			.split(/[;\n]/)
			.map((segment) => segment.trim())
			.filter((segment) => segment !== '')
		for (const segment of segments) {
			for (const path of localFirst(pathsInStatement(segment, vars))) push(path)
		}
		if (out.length > 0) return finish()
		for (const path of localFirst(extractPaths(command, 8))) push(path)
		if (out.length > 0) return finish()
	}
	for (const path of extractPaths(expandEnvVars(o.justification, env), 3)) push(path)
	// `New-Item -Path C:\tmp; Set-Content C:\tmp\x.txt` 会把上级目录也收进来：子路径已经
	// 说明了同一件事，目录单独列一遍只是让首行变长。
	return finish()
}

/**
 * 操作名 → 影响分类标签。
 * @param {string} operation 操作名。
 * @returns {string} `写入` / `修改` / `删除` / `读取` / `执行`。
 */
export function kindFor(operation) {
	return OPERATION_KINDS[String(operation ?? '')] ?? DEFAULT_KIND
}

/**
 * 把审批请求压成两行中文：第一行「对（目标）进行（操作） [ 分类 ]」，第二行「权限：（范围）」。
 * @param {{toolName?: unknown, mode?: unknown, justification?: unknown, args?: object|null, argsSource?: string, cwd?: unknown}} input 审批要点。
 * @returns {string} 形如 `对 D:\x\b.txt 进行重命名 [ 修改 ]\n权限：完全访问（…）`。
 */
export function buildSummaryLine(input) {
	const o = input || {}
	const env = o.env ?? null
	const command = expandEnvVars(commandOf(o.args ?? null), env)
	const hit = matchOperation(command)
	const operation = hit.operation !== '' ? hit.operation : operationFor({ command, toolName: o.toolName })
	const facts = {
		args: o.args ?? null,
		command,
		statement: hit.statement,
		justification: o.justification,
		cwd: o.cwd,
		env
	}
	const targets = targetListFor(facts)
	let target = ''
	if (targets.length === 0) {
		// 一条路径都没有：退回「命令行 …」/「当前工作目录 …」这种线索式目标。
		target = targetFor(facts)
	} else {
		// 全部路径都写进「对 … 进行」之间：一次要动三处文件时，只写第一处等于瞒了两处。
		const shown = targets.slice(0, TARGET_LIST_MAX)
		const more = targets.length > shown.length ? ` 等 ${targets.length} 处` : ''
		target = `${shown.join('、')}${more}`
	}
	// 一个路径都拿不到时（会话事件缺失、命令里没有绝对路径、连理由里也没写）：老实写
	// 「未知位置」。此前的 `进行命令执行 [ 执行 ]` 少了「对什么」这一半，读者根本没法判断
	// 要不要放行，而且和「有目标但很短」在版面上长得一样，更容易被当成已显示。
	let head = target === '' ? `对 未知位置 进行${operation}` : `对 ${target} 进行${operation}`
	head += ` [ ${kindFor(operation)} ]`
	// 参数是从「最近一次同名调用」回溯来的：标注出来，别当成这次的精确目标。
	if (o.argsSource === 'lastSameTool' && target !== '') head += '（回溯最近同名调用）'
	const scope = MODE_SCOPE[String(o.mode ?? '').trim()]
	return scope === undefined ? head : `${head}\n权限：${scope}`
}

/**
 * 判断文案是否已经带上总结（幂等：别重复加）。
 * @param {unknown} zh 当前中文文案。
 * @returns {boolean} 已有总结时为 true。
 */
export function hasSummary(zh) {
	return /^(?:对 .+ 进行|进行)[^\u2028\n]*[ \u2028\n]权限：/.test(String(zh ?? ''))
}

/**
 * 把带 `\n` 的文案转成界面能真正断行的形式。
 * @param {string} text 内部用 `\n` 分行的文案。
 * @returns {string} 供 displayReason 使用的文案。
 */
export function toDisplayText(text) {
	return String(text ?? '')
		.split('\n')
		.join(DISPLAY_BREAK)
}

/**
 * 把展示文案里的沙箱模式标识换成中文名。
 * @param {unknown} text 原始展示文案。
 * @returns {string} 换好模式名的文案；没有模式标识时与输入一致。
 */
export function localizeSandboxModes(text) {
	let out = typeof text === 'string' ? text : String(text ?? '')
	for (const [mode, label] of MODE_LABELS) out = out.split(mode).join(label)
	return out
}

/**
 * 从审批请求里解析出目标沙箱模式与模型给出的理由。
 * @param {unknown} reason 请求的 `reason`：`escalate sandbox to <mode>: <justification>`。
 * @returns {{mode: string, justification: string}} 解析结果（解析不出时 mode 为空串）。
 */
export function parseEscalationReason(reason) {
	const text = String(reason ?? '')
	const mode = Object.keys(MODE_SCOPE).find((m) => text.includes(m)) ?? ''
	const cut = text.indexOf(': ')
	return { mode, justification: cut >= 0 ? text.slice(cut + 2) : '' }
}

/** 模式中文名 → 模式标识，用来从已经本地化过的文案里把模式捞回来。 */
const MODE_ALIASES = new Map([
	...[...MODE_LABELS].map(([id, label]) => [label, id]),
	...Object.entries(MODE_SCOPE).map(([id, scope]) => [scope, id]),
	['完全访问', 'danger-full-access'],
	['仅工作区可写', 'workspace-write'],
	['只读', 'read-only']
])

/**
 * 从任意展示文案里认出沙箱模式。
 *
 * 提权请求的 `reason` 有时已经被审批门换成了它自己的中文块（`操作：… / 路径：…`），
 * 模式标识就没了解析来源 —— 但宿主给的第二行 `displayReason` 里还有（`允许本次操作
 * 使用 danger-full-access 权限：…`，或我们上一轮改成中文后的版本）。认不出来时卡片
 * 会少一整行「权限：…」，用户就不知道这次给的是哪种权限。
 * @param {unknown} text 候选文案。
 * @returns {string} 模式标识；认不出时为空串。
 */
export function modeFromText(text) {
	const s = typeof text === 'string' ? text : String(text ?? '')
	if (s === '') return ''
	for (const id of Object.keys(MODE_SCOPE)) if (s.includes(id)) return id
	for (const [label, id] of MODE_ALIASES) if (s.includes(label)) return id
	return ''
}

/**
 * 把宿主提权模板拆成「理由」部分。
 *
 * 模板形如 `允许本次操作使用 <mode> 权限：<模型说明>`。模式名已经由总结里的
 * `权限：` 行说清，重复一遍只是噪音；模型写的那句理由才是人要看的东西。
 * @param {unknown} text 展示文案原文。
 * @returns {string|null} 模板里的理由；不是模板或没有理由时为 null。
 */
export function splitHostTemplate(text) {
	const match = /^允许本次操作使用\s*.+?\s*权限[：:]\s*([\s\S]*)$/.exec(String(text ?? '').trim())
	if (match === null) return null
	const justification = match[1].trim()
	return justification === '' ? null : justification
}

/**
 * 判断宿主/审批门给出的 `reason` 是否值得原样附在卡片下方。
 * 它通常带着下游的拦截理由（「目标含工作区外路径 1 处：…」「判定器不可用」），
 * 是用户决定放不放行的关键依据，不能因为要显示精确目标就把它丢掉。
 * @param {string} text `reason` 原文。
 * @param {string} summary 已生成的总结行。
 * @returns {boolean} 需要附加时为 true。
 */
export function shouldAppendReason(text, summary) {
	const reason = String(text ?? '').trim()
	if (reason === '' || reason.length > 300) return false
	// 提权模板（`escalate sandbox to <mode>: <justification>`）是机器英文文本，
	// 中文卡片上没意义；justification 已经进了总结。
	if (/^escalate sandbox to /i.test(reason)) return false
	if (reason === summary) return false
	return true
}

/** 审批门列举目标的行：`目标含工作区外路径 7 处：a , b , c`。 */
const GATE_PATH_LIST_RE = /^(目标含工作区外路径|目标|路径清单)\s*(\d+)\s*处\s*[：:]\s*(.*)$/s

/** 审批门整块理由里值得保留的字段行（其余行视为误带进来的正文）。 */
const GATE_FIELD_RE = /^(?:目标|拦截|影响|原因|网络外发|网络|权限|判定|分类|范围|风险|来源|工具|技能|命令|说明|破坏性动作|动作|围栏)[：:]/

/** 正则/代码片段常带这些字符，真路径几乎不会。 */
const CODE_SNIFF_RE = /[()[\]|^$*?<>"`]/

/**
 * 判断审批门列出来的一项是否像真路径。
 *
 * 审批门会对**写入内容**也做路径抽取，于是我们改代码时它会把正文里的 `p://`（来自
 * `http://`）、`/**`（注释块）、`C:\\a`（测试字面量）、`/(?:[A-Za-z]:[\\/]|…)`（正则）当成
 * 「工作区外路径」。这些假项进卡片只会让本来要看清的目标变得更含糊，所以在这里滤掉。
 * @param {string} token 待判定的片段。
 * @param {{shown?: string, cwd?: string}} [context] 已知的真目标/工作目录，用于剔除被截断的前缀。
 * @returns {boolean} 是否像真路径。
 */
/**
 * 审批门部分版本会把路径里的反斜杠再转义一层（`C:\\Users\\…`），
 * 卡片上多出来的双反斜杠既难读、也没法直接复制去用。
 * @param {unknown} text 待还原的文本。
 * @returns {string} 还原后的文本。
 */
function unescapeBackslashes(text) {
	let out = typeof text === 'string' ? text : String(text ?? '')
	while (out.includes('\\\\')) out = out.split('\\\\').join('\\')
	return out
}

/**
 * 从候选里挑「更像这次要动的东西」的那个：本地路径优先于 URL。
 *
 * `Invoke-RestMethod https://… -OutFile C:\…\package.json` 里 URL 只是数据来源，
 * 真正被改动的是本地文件；只显示 URL 会让人以为这次只发了个网络请求。
 * 命令里只有 URL（纯网络操作）时才回退到 URL。
 * @param {string[]} paths 候选路径。
 * @returns {string|undefined} 选中的路径。
 */
function preferLocal(paths) {
	const list = Array.isArray(paths) ? paths : []
	const local = list.find((p) => !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(p))
	return local !== undefined ? local : list[0]
}

/**
 * 同上，但保留全部本地路径 —— 首行要一次写清所有目标，只留一个就白费了。
 * 一条命令里既有 URL 又有本地文件时，URL 只是数据来源，不该占「对 … 进行」的位置。
 * @param {string[]} paths 候选路径。
 * @returns {string[]} 本地路径（一个都没有时返回原列表）。
 */
function localFirst(paths) {
	const list = Array.isArray(paths) ? paths : []
	const local = list.filter((p) => !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(p))
	return local.length > 0 ? local : list
}

/** 看起来是一条路径（不是正则片段，也不是被盘符规则误伤的 `p://`）。 */
function looksLikePath(token) {
	if (token === '') return false
	if (JUNK_PATH_RE.test(token)) return false // `\\?\$p`、`C:\tmp exists={0}`
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/$/.test(token)) return false // `p://`
	if (/^[*\/]+$/.test(token)) return false // `/**`、`//`
	if (!/[\\/]/.test(token)) return false // 连分隔符都没有
	return !CODE_SNIFF_RE.test(token) // 正则 / 代码片段
}

/**
 * 与首行目标指的是同一处：完全相同，或是它被空白截断后的前缀
 * （`D:\DeepSeek` 之于 `D:\DeepSeek Harness工作目录\…`）。
 * 这类项不算「另一处」，但也不能当成噪声丢掉 —— 计数要留住，并注明「同上」。
 */
function isSameAsShown(token, context) {
	const lower = token.toLowerCase()
	const raw = context?.shownList ?? (context?.shown === undefined ? [] : [context.shown])
	for (const item of raw) {
		const shown = String(item ?? '').trim().toLowerCase()
		if (shown === '') continue
		if (shown === lower) return true
		if (shown.startsWith(lower) && shown.length > lower.length) return true
	}
	return false
}

/**
 * 只是工作目录被截断的残片。它既不是本次目标、也不是「另一处」——
 * 说「同上」会指错地方（上面写的是文件，不是工作目录），所以直接当噪声丢掉。
 */
function isCwdTruncation(token, context) {
	const lower = token.toLowerCase()
	const cwd = String(context?.cwd ?? '').trim().toLowerCase()
	if (cwd === '' || cwd === lower) return false
	return cwd.startsWith(lower) && cwd.length > lower.length
}

/**
 * 下游理由瘦身。
 *
 * 审批门（dsh-approval-gate）把 `reason` 换成整块
 * `操作：… / 路径：… / 目标：… / 拦截：… / 原因：…`，其中「操作」「路径」是它自己按空白
 * 截断过的版本 —— 与我们的首行重复、而且更含糊（`D:\DeepSeek、…`）。留着只会让卡片变长、
 * 把精确目标埋掉；「目标 / 拦截 / 原因」是它独有的判断依据，必须保留。
 *
 * 单行的转人工理由（`目标含工作区外路径 N 处：a , b`）同样保留，但会去掉与首行重复的目标
 * 和上面那类伪路径，只留下真正「还有别处」的部分。
 * @param {unknown} reason `reason` 原文。
 * @param {string} [shownTarget] 首行已经写明的目标，用于去重。
 * @param {string} [cwd] 会话工作目录，用于识别被截断的路径前缀。
 * @returns {string} 瘦身后的文本。
 */
export function trimDownstreamReason(reason, shownTarget = '', cwd = '') {
	const text = String(reason ?? '')
	const shownList = (Array.isArray(shownTarget) ? shownTarget : [shownTarget])
		.map((item) => String(item ?? '').trim())
		.filter((item) => item !== '')
	// 多行 = 审批门的「整块理由」形态；单行 = 它一句话的转人工依据。
	const multiLine = text.includes('\n')
	const kept = []
	for (const line of text.split('\n')) {
		const head = unescapeBackslashes(line.trim())
		if (head === '') continue
		if (/^(?:操作|路径)[：:]/.test(head)) continue
		// 门把命令也记一行，但它是按换行截断的：多行脚本只剩 `$paths = @(` 这种开场白，
		// 首行已经写清操作和目标，这半句话只会在卡片上添噪声。
		if (/^命令[：:]/.test(head) && isTruncatedCommand(head.replace(/^命令[：:]\s*/, ''))) continue
		const list = GATE_PATH_LIST_RE.exec(head)
		if (list === null) {
			// 单行理由（`目标含工作区外路径 1 处`、`判定器不可用`）整句保留 —— 它就是转人工的
			// 全部依据。多行块里偶尔混进文件正文或脚本片段（门抽目标时把内容一起带了出来），
			// 那些行只会在卡片上添噪声，所以按字段白名单滤掉。
			if (!multiLine || GATE_FIELD_RE.test(head)) kept.push(head)
			continue
		}
		const [, label, count, rest] = list
		const context = { shownList, cwd }
		// 门有时把围栏结论接在同一行（`… 1 处：<路径>；破坏性动作：Remove-Item $keep -Recurse`）。
		// 不先切开就会把「路径 + 句子」当成一个 token：里面有 `$`，被代码嗅探整条丢掉 ——
		// 于是路径和拦截理由一起消失。先按分号拆成「路径段 + 尾随字段」。
		const [pathPart, ...trailing] = String(rest).split(/[；;]/).map((s) => s.trim())
		const candidates = String(pathPart ?? '')
			.split(/\s*[,，、]\s*/)
			.map((item) => item.trim())
			.filter((item) => item !== '')
		const items = []
		let dupCount = 0
		for (const item of candidates) {
			if (!looksLikePath(item)) continue
			// 先判「目录残片」：工作目录本身被空白截断的产物（`D:\DeepSeek`），
			// 它同时也是首行文件的上级目录，但那不代表「还有一处」。
			if (isCwdTruncation(item, context)) continue
			if (isSameAsShown(item, context)) {
				dupCount += 1
				continue
			}
			items.push(item)
		}
		const total = Number(count)
		// 「N 处」里的 N 混着两类不该单列的项：从文件正文误抽的伪路径、与首行重复的目标。
		// 前一类不计；后一类是真路径，只是上面已经写清楚了 —— 计数留住、点明「同上」，
		// 不然用户会以为还有一处被藏了。
		const realCount = items.length + dupCount
		// 首行列的条数已不少于门报的处数：这句统计不再包含任何新信息，纯占版面。
		const covered = Number.isFinite(total) && total > 0 && shownList.length >= total
		if (items.length === 0) {
			if (dupCount > 0) {
				// 单目标形态仍要点明「就是上面那个」；多目标形态下首行已列全，直接省掉。
				if (!covered || shownList.length <= 1) kept.push(`${label} ${count} 处（就是上面那个）`)
			} else if (!covered) {
				// 列出的全是噪声（正则片段、被盘符规则误伤的东西），但「门确实报了 N 处」要留住，
				// 否则卡片看起来像什么都没发生。
				kept.push(`${label} ${count} 处`)
			}
		} else {
			const head2 = realCount === total ? `${label} ${count} 处` : `${label} ${items.length} 处`
			const shownItems = items.slice(0, 5)
			const more = items.length > shownItems.length ? ` 等 ${items.length} 处` : ''
			const same = dupCount > 0 ? `（另有 ${dupCount} 处同上）` : ''
			kept.push(`${head2}：${shownItems.join('、')}${more}${same}`)
		}
		for (const chunk of trailing) {
			if (chunk === '' || !GATE_FIELD_RE.test(chunk)) continue
			if (/^(?:操作|路径)[：:]/.test(chunk)) continue
			kept.push(chunk)
		}
	}
	return kept.join('\n')
}

/**
 * 去掉一行字段的标签（`原因：xxx` → `xxx`），用于判断两行是否在说同一件事。
 * @param {string} line 一行文案。
 * @returns {string} 去标签后的值（小写）。
 */
function fieldValueOf(line) {
	const text = String(line ?? '').trim()
	const match = /^[^：:\n]{1,8}[：:]\s*([\s\S]*)$/.exec(text)
	return (match === null ? text : match[1].trim()).toLowerCase()
}

/**
 * 丢掉「值与已输出的某一行相同」的下游字段。
 * @param {string[]} lines 待加入的下游行。
 * @param {string[]} parts 已经确定要输出的行。
 * @returns {string[]} 需要保留的行。
 */
function dropRepeatedFields(lines, parts) {
	const seen = new Set(parts.map((part) => fieldValueOf(part)).filter((value) => value !== ''))
	return (Array.isArray(lines) ? lines : []).filter((line) => {
		const value = fieldValueOf(line)
		return value !== '' && !seen.has(value)
	})
}

/** 已经标过序号的尾巴，用来保证重复调用不叠加。 */
const ORDINAL_TAIL_RE = /（同一次操作的第 \d+ 个审批请求）\s*$/

/**
 * 门记下的那行命令是否只是多行脚本的第一行残句。
 *
 * 线上形态：`命令：$paths = @(` —— 值的结尾是明显的未完成符号，或者短得不可能说明
 * 「这条命令在干什么」。这种行留在卡片上只会让人以为命令被截断了。
 * @param {string} value 命令值（已去掉「命令：」前缀）。
 * @returns {boolean} 是残句时为 true。
 */
function isTruncatedCommand(value) {
	const text = String(value ?? '').trim()
	if (text === '') return true
	if (/[@(\[{=+]$/.test(text)) return true
	if (/\b(?:try|if|foreach|for|while)\s*\($/.test(text)) return true
	return text.length < 12 && !/[\\/]/.test(text)
}

/**
 * 从首行 `对 a、b、c 等 N 处 进行…` 里把已经列举出来的目标拆回来，用于下游去重。
 * @param {unknown} zh 当前文案。
 * @returns {string[]} 首行已写明的目标列表。
 */
function shownTargetsOf(zh) {
	const first = String(zh ?? '').split('\n')[0]
	const inner = /^对\s+([\s\S]*?)\s+进行/.exec(first)?.[1] ?? ''
	if (inner === '') return []
	return inner
		.replace(/\s*等\s*\d+\s*处\s*$/, '')
		.split('、')
		.map((item) => item.trim())
		.filter((item) => item !== '')
}

/**
 * 给「同一次调用的第 N 个审批请求」加个记号。
 *
 * 一次工具调用可能被问两次：审批门先问「放不放行」，工具再问「给不给更大权限」
 * （`dsh-sandbox` 的 `approveEscalation`）。两条请求各有一张卡、各自等着被作答，看起来像
 * 两件不同的事，而且文案完全不同 —— 不标出来，用户会以为自己点错了、或者被重复打扰。
 * @param {string} zh 已生成的展示文案。
 * @param {number} ordinal 本次是该 callId 上的第几个审批请求（1 起）。
 * @returns {string} 加过记号的文案；不需要加或已加过时原样返回。
 */
export function markRepeatOrdinal(zh, ordinal) {
	const text = String(zh ?? '')
	const n = Math.trunc(Number(ordinal))
	if (text === '' || !Number.isFinite(n) || n < 2) return text
	const lines = text.split('\n')
	if (ORDINAL_TAIL_RE.test(lines[0])) return text
	// 首行可能以 `toDisplayText` 的换行分隔符残留的空格结尾，先削掉再接标记。
	lines[0] = `${lines[0].replace(/\s+$/, '')}（同一次操作的第 ${n} 个审批请求）`
	return lines.join('\n')
}

/**
 * 把一次审批请求的展示文案改成「精确目标 + 下游理由」。
 *
 * 覆盖两种请求形态：
 *   · 宿主模板提权：带 `displayReason.zh`（「允许本次操作使用 … 权限：<模型说明>」），`reason` 里有 `<mode>`；
 *     模型说明往往只写一个名词/短路径，所以要补目标；
 *   · 审批门转人工：**没有** `displayReason`，`reason` 已被换成它自己的中文说明
 *     （线上实测形如「目标含工作区外路径 1 处：C:\Windows\Temp」）。这类请求若被跳过，
 *     卡片上就只剩那句粗粒度说明 —— 用户报的「看不到实际要动的位置」正是它。
 * @param {object} req 审批请求（会被就地改写 `displayReason`）。
 * @param {{args?: object|null, argsSource?: string, cwd?: string}} facts 调用事实（由 index.mjs 取好传进来）。
 * @returns {string} 最终写入的 `zh`；没改动时为空串。
 */
export function applySummaryText(req, facts) {
	const display = req.displayReason
	const hasZh = display !== null && typeof display === 'object' && typeof display.zh === 'string'
	const rawZh = hasZh ? display.zh : ''
	const rawReason = String(req.reason ?? '')
	const escalation = parseEscalationReason(rawReason)
	let mode = escalation.mode
	const justification = escalation.justification
	// 提权请求也会先过审批门：门可能已经把 `reason` 换成了它自己的中文块，
	// 模式标识就只剩 `displayReason` 里还有。认不出来时「权限：」整行会消失。
	if (mode === '') mode = modeFromText([display?.zh, display?.en].filter((v) => typeof v === 'string').join(' '))
	const args = facts?.args ?? null
	// 既看不到真实操作、也解析不出提权模式：宁可不改，也不要凭空编一句。
	if (args === null && mode === '') return ''
	const summary = buildSummaryLine({
		toolName: req.toolName,
		mode,
		justification,
		args,
		argsSource: facts?.argsSource,
		cwd: facts?.cwd,
		env: facts?.env ?? null
	})
	const parts = []
	if (!hasSummary(rawZh)) parts.push(summary)
	// 首行已经写明的目标：下游理由里重复列举它只是噪音（还会带上被截断的版本）。
	const shownTargets = hasSummary(rawZh)
		? shownTargetsOf(rawZh)
		: targetListFor({
				args,
				command: expandEnvVars(commandOf(args), facts?.env ?? null),
				justification,
				cwd: facts?.cwd,
				env: facts?.env ?? null
			})
	if (hasZh) {
		// 宿主模板：「允许本次操作使用 <mode> 权限：<理由>」—— 模式已由权限行表达，
		// 只留理由，别再让同一句话出现两遍。
		const fromTemplate = splitHostTemplate(rawZh)
		if (fromTemplate !== null) parts.push(`理由：${localizeSandboxModes(fromTemplate)}`)
		else {
			const localized = localizeSandboxModes(rawZh)
			if (localized.trim() !== '') parts.push(localized)
		}
	}
	if (justification !== '' && !hasZh) {
		// 宿主提权模板只出现在 `reason` 里（没有 displayReason）：`escalate sandbox to
		// <mode>: <理由>` 的机器英文前缀不该上卡片，但后面那句模型写的理由必须留下 ——
		// `shouldAppendReason` 会把整条 `escalate …` 判为不必附加，于是理由就凭空消失了。
		parts.push(`理由：${justification}`)
	}
	// `reason` 不是提权模板，而是审批门换上的中文块：那是它独有的判断依据
	// （目标/拦截/原因），宿主给了 `displayReason` 也不能把它挤掉。
	if (escalation.mode === '' && justification === '') {
		const downstream = trimDownstreamReason(rawReason, shownTargets, facts?.cwd ?? '')
		if (shouldAppendReason(downstream, summary)) {
			// 门会把模型写的那句理由也记成 `原因：…`，与上面的 `理由：…` 一字不差；
			// 同一句话出现两遍只会让卡片更长。
			for (const line of dropRepeatedFields(downstream.split('\n'), parts)) parts.push(localizeSandboxModes(line))
		}
	}
	const zh = toDisplayText(parts.join('\n'))
	if (zh === rawZh) return ''
	const en = typeof display?.en === 'string' && display.en !== '' ? display.en : summary
	req.displayReason = Object.assign({}, hasZh ? display : null, { en, zh })
	return zh
}
