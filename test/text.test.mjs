/**
 * 纯函数回归：这几条断言对应「审批卡看不到实际要动的位置」的每一种成因。
 * 跑：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
	applySummaryText,
	buildSummaryLine,
	expandEnvVars,
	extractPaths,
	hasSummary,
	localizeSandboxModes,
	markRepeatOrdinal,
	modeFromText,
	pruneRedundantFields,
	shouldAppendReason,
	trimDownstreamReason,
	DISPLAY_BREAK
} from '../src/text.mjs'

const WORK = 'D:\\DeepSeek Harness工作目录\\DeepSeek'

test('引号包裹的整段路径不被空白切断', () => {
	assert.deepEqual(extractPaths(`Get-Content '${WORK}\\device-audit\\props.txt'`), [`${WORK}\\device-audit\\props.txt`])
	assert.deepEqual(extractPaths(`Set-Content "${WORK}\\note b.txt" -Value x`), [`${WORK}\\note b.txt`])
})

test('未加引号但带空格的路径向后接续完整', () => {
	assert.deepEqual(extractPaths(`Remove-Item ${WORK}\\tmp\\a.txt -Force`), [`${WORK}\\tmp\\a.txt`])
})

test('接续在选项、操作符、中文标点处停住', () => {
	assert.deepEqual(extractPaths('cd C:\\Windows\\Temp && dir'), ['C:\\Windows\\Temp'])
	assert.deepEqual(extractPaths('删除 C:\\a\\b.txt，然后汇报'), ['C:\\a\\b.txt'])
})

test('没有路径时返回空数组，不编造', () => {
	assert.deepEqual(extractPaths('这是一句没有路径的中文说明'), [])
})

test('写入类工具：目标取 file_path 原文，路径不被截短', () => {
	const line = buildSummaryLine({
		toolName: 'write',
		mode: 'workspace-write',
		justification: '写审计结果',
		args: { file_path: `${WORK}\\device-audit\\report-2026-11.json` },
		argsSource: 'callId'
	})
	assert.equal(line, `对 ${WORK}\\device-audit\\report-2026-11.json 进行写入文件 [ 写入 ]\n权限：仅工作区可写（工作区外仍被拒绝）`)
	assert.ok(hasSummary(line))
})

test('命令类工具、无沙箱模式：不输出权限行', () => {
	const line = buildSummaryLine({
		toolName: 'pwsh',
		mode: '',
		justification: '读取 adb 属性',
		args: { command: `Get-Content '${WORK}\\device-audit\\props.txt'` },
		argsSource: 'callId'
	})
	assert.equal(line, `对 ${WORK}\\device-audit\\props.txt 进行查找或读取 [ 读取 ]`)
})

test('回溯得到的参数要标注出来', () => {
	const line = buildSummaryLine({
		toolName: 'edit',
		mode: '',
		justification: '改文案',
		args: { file_path: 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\cordis.patch.yml' },
		argsSource: 'lastSameTool'
	})
	assert.ok(line.endsWith('（回溯最近同名调用）'))
})

test('宿主提权模板：补目标行，模板只留模型理由', () => {
	const req = {
		toolName: 'write',
		callId: 'c1',
		reason: 'escalate sandbox to workspace-write: 需要写审计结果',
		displayReason: {
			en: 'Allow this operation with workspace-write permissions: 需要写审计结果',
			zh: '允许本次操作使用 workspace-write 权限：需要写审计结果'
		}
	}
	const zh = applySummaryText(req, { args: { file_path: `${WORK}\\device-audit\\report.json` }, argsSource: 'callId' })
	const lines = zh.split(DISPLAY_BREAK)
	assert.equal(lines[0], `对 ${WORK}\\device-audit\\report.json 进行写入文件 [ 写入 ]`)
	assert.equal(lines[1], '权限：仅工作区可写（工作区外仍被拒绝）')
	// 模式已由权限行表达，模板退化成一句理由，不再重复「允许本次操作使用 … 权限」。
	assert.equal(lines[2], '理由：需要写审计结果')
	// reason 必须原样不动：上游拿它做判定与审计。
	assert.equal(req.reason, 'escalate sandbox to workspace-write: 需要写审计结果')
})

test('审批门转人工（没有 displayReason）：也要给出精确目标，并保留它的理由', () => {
	const req = { toolName: 'edit', callId: 'c2', reason: '目标含工作区外路径 1 处：C:\\Windows\\Temp' }
	const zh = applySummaryText(req, {
		args: { file_path: 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\cordis.patch.yml' },
		argsSource: 'callId'
	})
	const lines = zh.split(DISPLAY_BREAK)
	assert.equal(lines[0], '对 C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\cordis.patch.yml 进行修改文件 [ 修改 ]')
	assert.equal(lines[1], '目标含工作区外路径 1 处：C:\\Windows\\Temp')
	assert.equal(req.displayReason.zh, zh)
	assert.ok(typeof req.displayReason.en === 'string' && req.displayReason.en !== '')
})

test('幂等：已经带总结的文案不再叠加', () => {
	const existing = `对 ${WORK}\\a.md 进行修改文件 [ 修改 ]\n权限：仅工作区可写（工作区外仍被拒绝）`
	const req = { toolName: 'edit', reason: '目标含工作区外路径 1 处：D:\\x', displayReason: { en: 'x', zh: existing } }
	const zh = applySummaryText(req, { args: { file_path: `${WORK}\\a.md` }, argsSource: 'callId' })
	assert.equal(zh.split(DISPLAY_BREAK)[0], `对 ${WORK}\\a.md 进行修改文件 [ 修改 ]`)
	assert.equal(zh.split(DISPLAY_BREAK).filter((l) => l.startsWith('对 ')).length, 1)
})

test('看不见真实操作时不改：没有参数也没有模式', () => {
	const req = { toolName: 'unknown_tool', reason: '某处需要人工确认' }
	const zh = applySummaryText(req, { args: null, argsSource: 'none', cwd: '' })
	assert.equal(zh, '')
	assert.equal(req.displayReason, undefined)
})

test('提权模板不当作「下游理由」附加', () => {
	assert.equal(shouldAppendReason('escalate sandbox to read-only: x', 'y'), false)
	assert.equal(shouldAppendReason('目标含工作区外路径 1 处：C:\\a', 'y'), true)
	assert.equal(shouldAppendReason('', 'y'), false)
})

test('模式标识中文化', () => {
	assert.equal(
		localizeSandboxModes('允许本次操作使用 danger-full-access 权限'),
		'允许本次操作使用 完全访问（不受限） 权限'
	)
})

test('hasSummary 不误判普通说明', () => {
	assert.equal(hasSummary('目标含工作区外路径 1 处：C:\\a'), false)
	assert.equal(hasSummary('对 C:\\a 进行删除 [ 删除 ]\n权限：只读（不会修改任何文件）'), true)
})

test('URL 不被当成盘符路径：https:// 里的 p:// 不是路径', () => {
	// 线上真实缺陷：卡片上出现过「对 p://127.0.0.1:43189/ 进行下载」。
	assert.deepEqual(extractPaths('Invoke-WebRequest http://127.0.0.1:43189/ -UseBasicParsing'), ['http://127.0.0.1:43189/'])
	assert.deepEqual(extractPaths('curl -o out.txt https://example.com/a.zip'), ['https://example.com/a.zip'])
})

test('URL 与文件路径并存时两者都能取到', () => {
	const paths = extractPaths('Invoke-WebRequest https://example.com/a.zip -OutFile C:\\tmp\\a.zip', 2)
	assert.deepEqual(paths, ['https://example.com/a.zip', 'C:\\tmp\\a.zip'])
})

test('环境变量展开：$env: / ${env:} / %VAR%', () => {
	const env = { DSH_HOME: 'C:\\Users\\Administrator\\.dsh' }
	assert.equal(
		expandEnvVars('$env:DSH_HOME\\profiles\\a.yml', env),
		'C:\\Users\\Administrator\\.dsh\\profiles\\a.yml'
	)
	assert.equal(expandEnvVars('${env:DSH_HOME}/x', env), 'C:\\Users\\Administrator\\.dsh/x')
	assert.equal(expandEnvVars('%DSH_HOME%\\y', env), 'C:\\Users\\Administrator\\.dsh\\y')
	// 取不到值就原样保留，不编造。
	assert.equal(expandEnvVars('$env:NOT_SET\\z', env), '$env:NOT_SET\\z')
})

test('命令类工具拿不到路径时显示命中语句，而不是只给工作目录', () => {
	const line = buildSummaryLine({
		toolName: 'pwsh',
		mode: '',
		justification: '跑一下审计脚本',
		args: { command: 'node ..\\audit.js --fix --verbose' },
		argsSource: 'callId',
		cwd: WORK
	})
	assert.equal(line, '对 命令行 node ..\\audit.js --fix --verbose 进行运行程序 [ 执行 ]')
})

test('命令只有相对路径时，把工具声明的执行目录一起显示', () => {
	// 线上真例：`node test/text.test.mjs` 配 `workdir`，只写命令行等于没写位置。
	const line = buildSummaryLine({
		toolName: 'pwsh',
		mode: '',
		justification: '跑测试',
		args: { command: 'node test/text.test.mjs 2>&1', workdir: `${WORK}\\plugins\\dsh-approval-card` },
		argsSource: 'callId',
		cwd: WORK
	})
	assert.equal(
		line,
		`对 命令行 node test/text.test.mjs 2>&1（在 ${WORK}\\plugins\\dsh-approval-card） 进行运行程序 [ 执行 ]`
	)
})

test('下游审批门的整块理由：去掉重复的「操作/路径」行，保留拦截与原因', () => {
	const reason = [
		'操作：修改',
		'路径：D:\\DeepSeek、D:\\DeepSeek Harness工作目录\\Audit\\deploy.ps1',
		'目标：工作区外',
		'拦截：可执行产物：写入了 exe / dll / 脚本等可执行文件',
		'原因：目标含工作区外路径 7 处：/NFL , /NDL'
	].join('\n')
	const trimmed = trimDownstreamReason(reason)
	assert.ok(!trimmed.includes('操作：'))
	assert.ok(!trimmed.includes('路径：'))
	assert.ok(trimmed.includes('拦截：'))
	assert.ok(trimmed.includes('原因：'))
	// 单行理由原样返回。
	assert.equal(trimDownstreamReason('目标含工作区外路径 1 处：C:\\a'), '目标含工作区外路径 1 处：C:\\a')
})

test('审批门整块理由接入后：首行仍是精确目标，卡片不被它的路径行污染', () => {
	const req = {
		toolName: 'edit',
		callId: 'c3',
		reason: ['操作：修改', '路径：D:\\DeepSeek', '拦截：可执行产物', '原因：目标含工作区外路径 2 处：/NFL'].join('\n')
	}
	const zh = applySummaryText(req, {
		args: { file_path: `${WORK}\\Audit\\deploy.ps1` },
		argsSource: 'callId'
	})
	const lines = zh.split(DISPLAY_BREAK)
	assert.equal(lines[0], `对 ${WORK}\\Audit\\deploy.ps1 进行修改文件 [ 修改 ]`)
	assert.ok(!lines.some((line) => line.startsWith('路径：')))
	assert.ok(lines.some((line) => line.startsWith('拦截：')))
})

test('多行整块理由里混进来的正文行会被丢掉，字段行保留', () => {
	const reason = [
		'操作：写入',
		'路径：D:\\x\\a.mjs',
		'原因：目标含工作区外路径 3 处',
		'const handlers = []',
		'const ctx = { '
	].join('\n')
	const trimmed = trimDownstreamReason(reason, `${WORK}\\a.mjs`, WORK)
	assert.ok(!trimmed.includes('const handlers'))
	assert.ok(!trimmed.includes('const ctx'))
	assert.ok(trimmed.includes('原因：'))
})

test('目标列表剔掉被截断的前缀与伪路径', () => {
	const reason = '目标含工作区外路径 3 处：/profiles/x.mjs , D:\\DeepSeek , p://'
	const trimmed = trimDownstreamReason(reason, `${WORK}\\a.mjs`, WORK)
	// `D:\DeepSeek` 是工作目录的前缀截断、`p://` 是 URL 残片，都不是真目标。
	assert.equal(trimmed, '目标含工作区外路径 1 处：/profiles/x.mjs')
})

test('URL 与本地文件同时出现时，目标取本地文件', () => {
	// Invoke-RestMethod 的 URL 只是数据来源，真正被写的是 -OutFile 的本地文件。
	const args = {
		command: "$d='C:\\tmp\\pkg.json'\nInvoke-RestMethod https://registry.npmjs.org/x -OutFile $d"
	}
	const line = buildSummaryLine({ toolName: 'pwsh', mode: '', args, cwd: WORK })
	assert.ok(line.includes('C:\\tmp\\pkg.json'), line)
	assert.ok(!line.includes('https://'), line)
})

test('审批门把反斜杠再转义一层时，卡片上还原成单反斜杠', () => {
	const reason = '目标含工作区外路径 1 处：C:\\\\Users\\\\Administrator\\\\.dsh\\\\x'
	const trimmed = trimDownstreamReason(reason, `${WORK}\\a.mjs`, WORK)
	assert.equal(trimmed, '目标含工作区外路径 1 处：C:\\Users\\Administrator\\.dsh\\x')
})

test('门列的目标就是首行那个时，明说「就是上面那个」而不是留一个裸的 N 处', () => {
	const shown = 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\x.txt'
	const trimmed = trimDownstreamReason(`目标含工作区外路径 1 处：${shown}`, shown, WORK)
	assert.equal(trimmed, '目标含工作区外路径 1 处（就是上面那个）')
})

test('同一次调用的第二个审批请求会在首行末尾自报序号', () => {
	const zh = `对 C:\\tmp\\a.txt 进行写入文件 [ 写入 ]${DISPLAY_BREAK}权限：完全访问（整机可读写、含系统位置、不可自动回滚）`
	const marked = markRepeatOrdinal(zh, 2)
	const [first, ...rest] = marked.split('\n')
	assert.ok(first.endsWith('（同一次操作的第 2 个审批请求）'), marked)
	assert.ok(!/\s（同一次操作/.test(first), `标记前不应留空格: ${JSON.stringify(first)}`)
	assert.ok(!marked.includes('权限：完全访问（整机可读写、含系统位置、不可自动回滚）（同一'), marked)
	assert.equal(rest.join('\n').trim(), '权限：完全访问（整机可读写、含系统位置、不可自动回滚）')
})

test('第一个审批请求不加序号，重复加也只会有一个', () => {
	const zh = `对 C:\\tmp\\a.txt 进行写入文件 [ 写入 ]${DISPLAY_BREAK}权限：仅工作区可写（工作区外仍被拒绝）`
	assert.equal(markRepeatOrdinal(zh, 1), zh)
	const once = markRepeatOrdinal(zh, 3)
	assert.equal(markRepeatOrdinal(once, 3), once)
	assert.equal(once.match(/个审批请求/g).length, 1)
})

test('cd 的目标不是本次操作目标：命令里换了工作目录后真正动的是后面的文件', () => {
	const args = { command: `cd '${WORK}' && node ..\\audit.js --in C:\\tmp\\report.json` }
	const line = buildSummaryLine({ toolName: 'pwsh', mode: '', args, cwd: WORK })
	assert.ok(line.includes('C:\\tmp\\report.json'), line)
	assert.ok(!line.includes(`对 ${WORK} 进行`), line)
})

test('一个路径都拿不到时明写「未知位置」，不输出半句话', () => {
	// 会话事件缺失（args 为 null）、命令里没有绝对路径、理由里也没有 —— 线上真出现过
	// 「进行命令执行 [ 执行 ]」，读者看不出这次到底要动什么。
	const line = buildSummaryLine({ toolName: 'pwsh', mode: 'danger-full-access', justification: '临时需要', cwd: undefined })
	assert.ok(line.startsWith('对 未知位置 进行'), line)
	assert.ok(!line.includes('对 进行'), line)
})

test('没有文件目标的工具回退到工作目录（别退回「未知位置」）', () => {
	const line = buildSummaryLine({ toolName: 'dsh_browser_execute', mode: '', args: null, cwd: WORK })
	assert.ok(line.includes('当前工作目录'), line)
	assert.ok(line.startsWith(`对 当前工作目录 ${WORK} 进行`), line)
})

test('宿主只给 escalate 文本、没有 displayReason 时，模型写的理由要留下', () => {
	const req = {
		toolName: 'pwsh',
		reason: 'escalate sandbox to danger-full-access: 需要写系统临时目录里的校验文件'
	}
	const zh = applySummaryText(req, { args: null, cwd: undefined })
	const lines = zh.split(DISPLAY_BREAK)
	assert.ok(zh.includes('理由：需要写系统临时目录里的校验文件'), zh)
	assert.ok(!zh.includes('escalate sandbox'), zh)
	assert.ok(lines.some((l) => l.startsWith('权限：完全访问')), zh)
	assert.equal(req.reason, 'escalate sandbox to danger-full-access: 需要写系统临时目录里的校验文件')
})

test('分号后面的围栏结论不能被当成路径的一部分丢掉', () => {
	// 真实形态（2026-11-04 10:47）：门把围栏结论接在同一行，路径后面紧跟 `；破坏性动作：…`。
	// 曾经整条 token 因为含 `$` 被代码嗅探丢掉 —— 工作区外的临时目录和拦截理由一起消失。
	const reason =
		'目标含工作区外路径 1 处：C:\\Users\\me\\AppData\\Local\\Temp\\dsh-x\\dsh-approval-card-plugin；破坏性动作：Remove-Item $keep -Recurse'
	const out = trimDownstreamReason(reason, 'D:\\ws\\.build\\plugin-repo', 'D:\\ws')
	const lines = out.split('\n')
	assert.ok(out.includes('C:\\Users\\me\\AppData\\Local\\Temp\\dsh-x\\dsh-approval-card-plugin'), out)
	assert.ok(out.includes('破坏性动作：Remove-Item $keep -Recurse'), out)
	assert.equal(lines.length, 2, out)
})

test('被空白截断的前缀算「同上」，不能只留一个光秃秃的 N 处', () => {
	const out = trimDownstreamReason(
		'目标含工作区外路径 1 处：C:\\Users\\me\\.dsh\\node_modules\\dsh-approval-gate',
		'C:\\Users\\me\\.dsh\\node_modules\\dsh-approval-gate\\src\\paths.mjs',
		'D:\\ws'
	)
	assert.equal(out, '目标含工作区外路径 1 处（就是上面那个）')
})

test('有一处与首行重复时，计数保留并点明还有几处同上', () => {
	const reason =
		'目标含工作区外路径 2 处：C:\\Users\\me\\.dsh\\profiles\\desktop\\package.json , C:\\Users\\me\\.dsh\\profiles\\web\\package.json'
	const out = trimDownstreamReason(reason, 'C:\\Users\\me\\.dsh\\profiles\\desktop\\package.json', 'D:\\ws')
	assert.ok(out.startsWith('目标含工作区外路径 2 处：'), out)
	assert.ok(out.includes('C:\\Users\\me\\.dsh\\profiles\\web\\package.json'), out)
	assert.ok(out.includes('（另有 1 处同上）'), out)
})

test('门先换掉 reason、宿主又给了提权模板时，权限行与门的判断依据都不能丢', () => {
	// 真实形态（2026-11-04 10:59 第二张卡）：提权请求先过审批门，门把 reason 换成中文块，
	// 模式标识只剩 displayReason 里还有。曾经整张卡只剩「对 … 进行写入 [ 写入 ]」+「理由：…」，
	// 既不说是哪种权限，也看不到门为什么拦。
	const req = {
		toolName: 'pwsh',
		reason:
			'操作：写入文件\n路径：C:\\Windows\\Temp\\dsh-card-a.txt、C:\\Users\\Public\\dsh-card-b.txt',
		displayReason: {
			en: 'Allow this operation with danger-full-access permissions: 造一张多目录的卡',
			zh: '允许本次操作使用 danger-full-access 权限：造一张多目录的卡'
		}
	}
	const zh = applySummaryText(req, {
		args: { command: "Set-Content 'C:\\Windows\\Temp\\dsh-card-a.txt' -Value x" },
		cwd: WORK
	})
	const lines = zh.split(DISPLAY_BREAK)
	assert.ok(lines[0].startsWith('对 C:\\Windows\\Temp\\dsh-card-a.txt 进行写入文件'), zh)
	assert.ok(lines.some((l) => l.startsWith('权限：完全访问')), zh)
	assert.ok(lines.some((l) => l === '理由：造一张多目录的卡'), zh)
	assert.ok(!zh.includes('操作：'), zh)
	assert.ok(!zh.includes('路径：'), zh)
})

test('模式能从已经本地化成中文的模板里认回来', () => {
	assert.equal(modeFromText('允许本次操作使用 danger-full-access 权限：x'), 'danger-full-access')
	assert.equal(modeFromText('允许本次操作使用 完全访问（整机可读写、含系统位置、不可自动回滚） 权限：x'), 'danger-full-access')
	assert.equal(modeFromText('允许本次操作使用 仅工作区可写 权限：x'), 'workspace-write')
	assert.equal(modeFromText('目标含工作区外路径 1 处：C:\\tmp'), '')
})

test('一条命令动了三处目录时，三个路径全部写在「对」和「进行」之间', () => {
	const cmd =
		"Set-Content 'C:\\Windows\\Temp\\a.txt' -Value x; " +
		"Set-Content 'C:\\Users\\Public\\b.txt' -Value x; " +
		"New-Item -ItemType Directory -Path 'C:\\tmp' -Force; " +
		"Set-Content 'C:\\tmp\\c.txt' -Value x"
	const req = {
		toolName: 'pwsh',
		reason: '目标含工作区外路径 3 处：C:\\Windows\\Temp\\a.txt , C:\\Users\\Public\\b.txt , C:\\tmp\\c.txt'
	}
	const zh = applySummaryText(req, { args: { command: cmd }, cwd: WORK })
	const head = zh.split(DISPLAY_BREAK)[0]
	assert.ok(head.includes('C:\\Windows\\Temp\\a.txt'), zh)
	assert.ok(head.includes('C:\\Users\\Public\\b.txt'), zh)
	assert.ok(head.includes('C:\\tmp\\c.txt'), zh)
	// 子路径已说明同一件事，上级目录不再单列
	assert.ok(!head.includes('C:\\tmp、'), zh)
	assert.ok(head.endsWith('进行写入文件 [ 写入 ]'), zh)
	// 三个目标都上了首行，下游那行统计没有新信息，不该重复出现
	assert.equal(zh.split(DISPLAY_BREAK).length, 1, zh)
})

test('结构化字段给了两个文件时，两个都进首行', () => {
	const head = buildSummaryLine({
		toolName: 'write',
		args: { file_path: 'C:\\Users\\Public\\a.txt', path: 'C:\\Users\\Public\\b.txt' },
		cwd: WORK
	})
	assert.equal(head, '对 C:\\Users\\Public\\a.txt、C:\\Users\\Public\\b.txt 进行写入文件 [ 写入 ]')
})

test('门记下的命令只是一句开场白时，不要往卡片上贴', () => {
	const req = {
		toolName: 'pwsh',
		reason: [
			'操作：写入文件',
			'路径：C:\\Windows\\Temp\\a.txt',
			'命令：$paths = @(',
			'原因：按你的要求造一张卡'
		].join('\n')
	}
	const zh = applySummaryText(req, {
		args: { command: "Set-Content -Path 'C:\\Windows\\Temp\\a.txt' -Value x" },
		cwd: WORK
	})
	assert.ok(!zh.includes('命令：'), zh)
	assert.ok(!zh.includes('$paths'), zh)
})

test('门把理由也记成原因时，只留一遍', () => {
	const justification = '按你的要求造一张卡'
	const req = {
		toolName: 'pwsh',
		reason: `操作：写入文件\n路径：C:\\Windows\\Temp\\a.txt\n原因：${justification}`,
		displayReason: {
			en: `Allow this operation with danger-full-access permissions: ${justification}`,
			zh: `允许本次操作使用 danger-full-access 权限：${justification}`
		}
	}
	const lines = applySummaryText(req, {
		args: { command: "Set-Content -Path 'C:\\Windows\\Temp\\a.txt' -Value x" },
		cwd: WORK
	}).split(DISPLAY_BREAK)
	const hits = lines.filter((line) => line.includes(justification))
	assert.equal(hits.length, 1, lines.join(' | '))
	assert.ok(lines.some((line) => line === `理由：${justification}`), lines.join(' | '))
})

test('脚本里的变量引用和格式串不算目标', () => {
	const cmd = [
		"foreach ($p in @('C:\\Windows\\Temp\\a.txt','C:\\Users\\Public\\b.txt')) {",
		'  if (Test-Path -LiteralPath $p) { [System.IO.File]::Delete("\\\\?\\$p") }',
		"  '{0} exists={1}' -f $p, (Test-Path -LiteralPath $p)",
		'}'
	].join('\n')
	const head = buildSummaryLine({ toolName: 'pwsh', args: { command: cmd }, cwd: WORK })
	assert.ok(head.includes('C:\\Windows\\Temp\\a.txt'), head)
	assert.ok(head.includes('C:\\Users\\Public\\b.txt'), head)
	assert.ok(!head.includes('$p'), head)
	assert.ok(!head.includes('{0}'), head)
})

test('权限与影响说的是同一件事时只留影响', () => {
	// 首行与「权限：」是同一个片段的两行，摊平后「权限：」才认得出
	const parts = [
		'对 C:\\Windows\\Temp\\a.txt 进行写入文件 [ 写入 ]\n权限：完全访问（整机可读写、含系统位置、不可自动回滚）',
		'理由：造一张卡',
		'目标：工作区外',
		'影响：整机（工作区外任意路径可读写，含系统位置；改动不可自动回滚）'
	]
	const out = pruneRedundantFields(parts)
	assert.ok(!out.some((line) => line.startsWith('权限：')), out.join(' | '))
	assert.ok(out.some((line) => line.startsWith('影响：')), out.join(' | '))
	assert.ok(out.some((line) => line.startsWith('理由：')), out.join(' | '))
})

test('命令行整行不要，原因与理由重复时只留理由', () => {
	const out = pruneRedundantFields([
		'对 C:\\tmp\\a.txt 进行写入文件 [ 写入 ]',
		'理由：造一张卡',
		'命令：$paths = @(',
		'原因：造一张卡'
	])
	assert.deepEqual(out, ['对 C:\\tmp\\a.txt 进行写入文件 [ 写入 ]', '理由：造一张卡'])
})

test('没有影响行时权限行要留着', () => {
	const out = pruneRedundantFields([
		'对 C:\\tmp\\a.txt 进行写入文件 [ 写入 ]\n权限：仅工作区可写（工作区外仍被拒绝）'
	])
	assert.ok(out.some((line) => line.startsWith('权限：')), out.join(' | '))
})
