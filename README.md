# dsh-deepseek-usage-meter

在输入框下方那条统计条（`2 轮 252 步 · 263 tok/s · 63.7M tok · 缓存命中 99.6%`）里，
紧跟 token 用量之后常驻一枚指示器，显示**本次会话的实际开销**与**DeepSeek 官方账号的剩余额度**。
只考虑 DeepSeek 官方渠道（`deepseek-account` 账号渠道与 `deepseek-official` API Key 渠道）。

```
● ≈¥2.2103 · 余额 ¥11.23
```

行首那盏灯是**当前计费时段**：绿灯＝空闲时段，红灯＝高峰时段（悬停有文字说明，每分钟重算一次，
空闲时也不会停在旧状态）。点击展开明细：每个模型**各计费项目各花了多少钱**
（未缓存输入 / 缓存读取 / 缓存写入 / 输出，token 数放在悬停提示里）、该模型的缓存命中率、
本次开销在高峰/空闲两档上的拆分，以及账户的充值余额与赠送余额。

配色全部走 app 自己的设计 token（`--dsw-alias-*`、`--dsw-specific-menu`、`--dsw-elevation-panel`、
`--dsw-radius-*`），红绿灯用语义色 `--dsw-alias-state-success-primary` 与
`--dsw-alias-state-error-primary`，所以浅色/深色主题自动跟随，与统计条、菜单同一套风格。

面板刻意**不重复**统计条已经常驻显示的数字（会话总 token 数、会话级缓存命中率），
只用高峰/空闲金额拆分这类统计条没有的信息来解释这笔钱是怎么来的。

## 数据从哪来

| 显示项 | 来源 | 说明 |
|---|---|---|
| token 用量 | 会话日志里 provider 回报的 `TokenUsage` | 与 DSH 自己的 `tokenUsage` projection 逐字段一致（同一批 `assistant/message` / `assistant/attempt` 事件） |
| 计费模型 | `request/header` 事件里的 `config.provider` / `config.model` | 会话中途换模型会分别记账，不按"当前模型"回算历史 |
| 高峰/空闲 | 事件自带的 `time` 折算北京时间 | 周一至周五 9:00–12:00、14:00–18:00 为高峰；节假日全天按空闲 |
| 剩余额度 | `ctx.remote.account.getBalance()` | DSH 已登录的 DeepSeek 官方账号在平台侧的余额，充值/赠送分列 |

金额按 DeepSeek 官方价目表（USD 与 CNY 两套官方价，不做汇率换算）计算，
货币优先跟随账户钱包：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
|---|---|---|---|
| `deepseek-flash` | ¥0.02 / ¥0.04（空闲/高峰，每百万 tokens） | ¥1 / ¥2 | ¥4 / ¥8 |
| `deepseek-v4-pro` | ¥0.15 / ¥0.30 | ¥4.5 / ¥9 | ¥13.5 / ¥27 |

缓存写入（`cache_creation_input_tokens`）按**缓存未命中**价计入——DeepSeek 未单列缓存写入价格。

## 实现结构插件同时是 Host 行与浏览器行，一个包里两半：

- `lib/index.js`（Host 半边）：注册客户端可见的会话投影 `deepseekCost`，把
  "这一次请求走的是哪个 provider/model" 与"提供方回报了多少 token"折进同一份账本，
  并给每次用量打上高峰/空闲档位。不 import 任何包，因此没有依赖解析与版本兼容问题。
- `lib/client.js`（浏览器半边，经 `package.json` 的 `dsh.client` 被发现）：读该投影，
  按官方价目表折成金额，并把余额 Remote 的结果一起渲染。只 `require('react')`。
- `cordis.patch.yml`：bundle 补丁，插入一行 `deepseek-usage-meter`。

计费口径的关键实现决策：

- **重放不重复计费**：同一个 `(turn, step)` 再次出现结算（同一步骤内的重放/重报）时替换而不是累加；
  `llm/retry-started` 之后的第二次尝试才再次计入。
- **时段分桶**：`(provider, model, 高峰|空闲)` 各一个桶，历史用量不会因为现在几点而被重新定价。
- **金额在浏览器半边算**：Host 只提供可验证的事实（provider、model、档位、四类 token 数）。

### 三个踩过的坑（写给下一个改它的人）

1. **Remote 命名空间是独立服务**：网关为每个命名空间建 `remote.<namespace>` 服务
   （`RemoteNamespaceService` → `super(ctx, remoteServiceKey(name))`），而 Cordis 服务只有
   被 `inject` 才可见。所以余额走 `ctx.inject(['remote.account'], (scope) => scope.remote.account)`
   这条可选注入，拿不到也不阻塞插件（开销照常显示）。
2. **Remote 方法返回信封**：客户端方法返回 `RemoteResult<T>`，即 `{ ok: true, value }` 或
   `{ ok: false, error }`。shipped 的 ui-settings-account 也是先判 `result.ok` 再取 `result.value`。
   直接按裸值读会把成功结果误判成失败。
3. **服务访问用 `ctx.get(name)`**：直接写 `ctx.<未注入的服务>` 可能抛错，而渲染期抛错会让
   整个槽位条目被框架 abdicate（`active: false` 且不再恢复）。指示器外面还有一层错误边界兜底。
4. **位置选 `conversation.composer.dock`**：这条 dock 是横排 flex（`justify-content:center; gap:12px`），
   已经住着 token 用量统计条（`id: "stats"`, `order: 0`）。同槽位注册 `order: 10` 就并进同一行，
   样式也照抄统计条的 pill 语言（`--dsw-alias-label-tertiary`、`border-radius:999px`、14px 图标位）。

平台返回的钱包金额是原始串（如 `141.8000000000`），展示按平台网页口径处理：两位小数、
千分位分组、正数截断到分、不足一分显示 `<0.01`。

## 安装

已安装进 `desktop` profile，且是 `link:` 依赖，指向本仓库目录：

```json
"dependencies": { "dsh-deepseek-usage-meter": "link:<此目录>" },
"dsh": { "profile": { "bundles": [ ..., "dsh-deepseek-usage-meter" ] } }
```

改代码后让客户端重新加载一次 bundle（关闭再开启该插件）即可生效；重新安装同名包需要重启应用。

卸载：在 Plugins 页停用并移除，或 `pnpm remove dsh-deepseek-usage-meter` 于
`$DSH_HOME/profiles/desktop`，再从 `dsh.profile.bundles` 中删除该名字。

## 已知限制

- 价目表是**内置常量**：DeepSeek 调价后需要手动更新 `lib/client.js` 里的 `PRICES`。
- 节假日表只覆盖 **2026 年**（`lib/index.js` 的 `CN_HOLIDAY_RANGES_2026`）；跨年后补新表即可，
  未列出的法定假日会被按高峰计价（略微高估）。
- 金额是**按官方价目表换算的估算值**，且官方允许调价；平台账单为准。
- 只统计当前会话；跨会话/按天的累计开销不在本版范围内。
- 余额查询失败（未登录、断网、凭证过期）时只影响余额那一半，开销照常显示。

## 自测

```powershell
# 需要 DSH 自带的 Electron（用 ELECTRON_RUN_AS_NODE=1 当 node 用）
$exe = "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe"
$env:ELECTRON_RUN_AS_NODE = "1"
& $exe test/test-host.mjs      # Host 折叠语义：时段分桶、重放替换、重试、模型切换
& $exe test/test-client.cjs    # 计价与格式化（两套官方价、别名、未知模型、非官方渠道、红绿灯时段）
& $exe test/test-render.cjs    # 组件真渲染：chip 结构、面板内容、失败路径、错误边界
```

三个脚本都只依赖 Node 内置模块，不装任何依赖即可运行（用系统 node 也一样）。
