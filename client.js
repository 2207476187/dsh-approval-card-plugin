/**
 * dsh-approval-card 的浏览器半边：只做一件事 —— 让审批卡标题允许换行。
 *
 * 为什么需要它：审批卡标题元素（class 以 `_headline` 结尾，例如 `j_8BDW_headline`）
 * 的样式只有 `color/font-size/font-weight/line-height`，没有 `white-space`，也就是默认的
 * `normal` —— 浏览器会把文案里的换行统统折叠成空格。所以插件写进去的
 * 「动作行 / 权限行」在界面上永远显示成一行，服务端怎么拼都没用。
 *
 * 这里补一条 `white-space: pre-line`：换行保留、连续空格仍折叠 —— 正好是我们要的效果。
 * 用 class 后缀匹配而不是写死哈希名，审批 UI 重新构建、哈希变化后依然生效；
 * 样式通过 `ctx.effect` 注册，插件卸载时自动移除。
 */
window.__ModuleLoader__.load({
	id: 'dsh-approval-card',
	factory() {
		return {
			apply(ctx) {
				ctx.effect(() => {
					const tag = document.createElement('style')
					tag.dataset.plugin = 'dsh-approval-card'
					// `!important` 是刻意的：审批 UI 自己的样式表可能在本插件之后注入，
					// 同优先级下后者会赢。加 !important 后无论加载顺序如何都按换行渲染。
					tag.textContent = '[class*="_headline"]{white-space:pre-line !important}'
					document.head.appendChild(tag)
					return () => {
						tag.remove()
					}
				})
			}
		}
	}
})
