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
