/**
 * DeepSeek 官方渠道开销计量 —— 浏览器半边。
 *
 * 在输入框工具栏里放一枚常驻小 chip：`≈¥0.0123 · 余额 ¥45.67`，点开后是
 * 本次会话的分模型 token 账本、高峰/空闲计价明细，以及账户充值/赠送余额。
 *
 * 数据来源：
 * - 会话开销：Host 半边注册的 `deepseekCost` session projection（提供方回报的
 *   token 用量 + 该次请求实际使用的 provider/model + 计费时段）。
 * - 剩余额度：`ctx.remote.account.getBalance()`，即 DSH 已登录的 DeepSeek 官方
 *   账号（account 渠道）在平台侧的充值余额与赠送余额。
 *
 * 金额按 DeepSeek 官方价目表计算（USD / CNY 两套官方价，不做汇率换算）。
 * 本文件不 import 任何包，只依赖平台内置的 react 模块与 ctx 服务。
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-usage-meter',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** 与 Host 半边约定的 projection key。 */
    const KEY = 'deepseekCost'
    /** 账号 Remote 需要的客户端标识版本；与 DSH 客户端版本保持一致即可。 */
    const CLIENT_VERSION = '0.2.0-rc.2'
    /** 余额自动刷新间隔。 */
    const BALANCE_REFRESH_MS = 90_000

    /**
     * DeepSeek 官方价目表，单位：货币 / 百万 tokens。
     * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
     * 高峰时段为北京时间周一至周五 9:00-12:00、14:00-18:00（法定节假日除外），
     * 空闲时段价格为高峰价格的一半。
     */
    const PRICES = {
      'deepseek-flash': {
        CNY: { hit: { peak: 0.04, off: 0.02 }, miss: { peak: 2, off: 1 }, out: { peak: 8, off: 4 } },
        USD: { hit: { peak: 0.006, off: 0.003 }, miss: { peak: 0.3, off: 0.15 }, out: { peak: 1.2, off: 0.6 } },
      },
      'deepseek-v4-pro': {
        CNY: { hit: { peak: 0.3, off: 0.15 }, miss: { peak: 9, off: 4.5 }, out: { peak: 27, off: 13.5 } },
        USD: { hit: { peak: 0.044, off: 0.022 }, miss: { peak: 1.32, off: 0.66 }, out: { peak: 3.96, off: 1.98 } },
      },
    }

    /** 已下线但平台仍按 flash 计费的旧模型名。 */
    const MODEL_ALIASES = {
      'deepseek-v4-flash': 'deepseek-flash',
      'deepseek-v4-flash-vision-exp': 'deepseek-flash',
    }

    /** 未知模型的兜底价：按 flash 计并标注。 */
    const FALLBACK_MODEL = 'deepseek-flash'

    /** 会话开销只统计 DeepSeek 官方渠道；其它 provider 不出现在金额里。 */
    const OFFICIAL_ROUTES = new Set(['deepseek-official', 'deepseek-account', null, ''])

    const TOKEN_FIELDS = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']

    // ── 文案 ────────────────────────────────────────────────────────────────
    const TEXT = {
      'zh-CN': {
        cost: '开销',
        balance: '余额',
        title: 'DeepSeek 官方渠道开销',
        sessionCost: '本次会话',
        total: '合计',
        tokens: 'tokens',
        cacheHit: '缓存命中',
        peak: '高峰',
        off: '空闲',
        cacheRead: '缓存读取',
        cacheWrite: '缓存写入',
        uncached: '未缓存输入',
        output: '输出',
        account: '账户余额',
        toppedUp: '充值余额',
        granted: '赠送余额',
        refresh: '刷新',
        loading: '读取中…',
        signedOut: '未登录 DeepSeek 账号',
        unavailable: '余额接口不可用',
        failed: '余额查询失败',
        updated: '更新于',
        estimate: '按 DeepSeek 官方价格估算，金额仅供参考；平台账单为准。',
        noUsage: '本次会话尚无模型调用',
        unknownModel: '未知模型按 flash 价估算',
        otherRoute: '含非官方渠道用量（不计价）',
        signedIn: '账号已登录，平台查询失败',
        signOutState: '账号未登录',
      },
      'en-US': {
        cost: 'Cost',
        balance: 'Balance',
        title: 'DeepSeek official spend',
        sessionCost: 'This session',
        total: 'Total',
        tokens: 'tokens',
        cacheHit: 'Cache hit',
        peak: 'peak',
        off: 'off-peak',
        cacheRead: 'Cache read',
        cacheWrite: 'Cache write',
        uncached: 'Uncached input',
        output: 'Output',
        account: 'Account balance',
        toppedUp: 'Topped-up',
        granted: 'Granted',
        refresh: 'Refresh',
        loading: 'Loading…',
        signedOut: 'Not signed in to DeepSeek',
        unavailable: 'Balance API unavailable',
        failed: 'Balance query failed',
        updated: 'Updated',
        estimate: 'Estimated from DeepSeek official pricing; the platform bill is authoritative.',
        noUsage: 'No model call in this session yet',
        unknownModel: 'Unknown model priced as flash',
        otherRoute: 'Includes non-official usage (not priced)',
        signedIn: 'Signed in; platform query failed',
        signOutState: 'Account not signed in',
      },
    }

    /** 语言选择：只看主语言前缀，缺省中文。 */
    function pickText(active) {
      return typeof active === 'string' && active.toLowerCase().startsWith('en') ? TEXT['en-US'] : TEXT['zh-CN']
    }

    // ── 计价 ────────────────────────────────────────────────────────────────
    /** 归一化模型名（旧名归并到计费模型）。 */
    function normalizeModel(id) {
      if (typeof id !== 'string' || id === '') return null
      return MODEL_ALIASES[id] ?? id
    }

    /**
     * 取某模型在指定货币与时段下的单价。
     * @returns { hit, miss, out, known } —— 未知模型返回 flash 价并标记 known=false。
     */
    function priceFor(modelId, currency, window) {
      const normalized = normalizeModel(modelId)
      const table = PRICES[normalized] ?? PRICES[FALLBACK_MODEL]
      const row = table[currency] ?? table.CNY
      const slot = window === 'peak' ? 'peak' : 'off'
      return { hit: row.hit[slot], miss: row.miss[slot], out: row.out[slot], known: PRICES[normalized] !== undefined }
    }

    /** 一个桶的金额：未缓存输入与缓存写入都按未命中价计（DeepSeek 未单列缓存写入价）。 */
    function bucketCost(bucket, currency) {
      const price = priceFor(bucket.model, currency, bucket.window)
      const per = (tokens, unit) => (tokens * unit) / 1e6
      const parts = {
        uncached: per(bucket.uncachedInputTokens, price.miss),
        cacheRead: per(bucket.cacheReadTokens, price.hit),
        cacheWrite: per(bucket.cacheWriteTokens, price.miss),
        output: per(bucket.outputTokens, price.out),
      }
      return {
        parts,
        amount: parts.uncached + parts.cacheRead + parts.cacheWrite + parts.output,
        known: price.known,
      }
    }

    /** 把 Host 的桶数组折成「总金额 + 每模型明细（含各项目金额）+ 高峰/空闲拆分」。 */
    function sumCost(buckets, currency) {
      const byModel = new Map()
      const byWindow = { peak: 0, off: 0 }
      let total = 0
      let unpriced = 0
      let hasUnknown = false
      for (const bucket of buckets) {
        if (!OFFICIAL_ROUTES.has(bucket.provider ?? null)) {
          for (const field of TOKEN_FIELDS) unpriced += bucket[field]
          continue
        }
        const priced = bucketCost(bucket, currency)
        total += priced.amount
        byWindow[bucket.window === 'peak' ? 'peak' : 'off'] += priced.amount
        if (!priced.known) hasUnknown = true
        const entry = byModel.get(bucket.model ?? '?') ?? {
          model: bucket.model ?? '?',
          amount: 0,
          costs: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
          tokens: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
          windows: new Set(),
        }
        entry.amount += priced.amount
        for (const key of Object.keys(entry.costs)) entry.costs[key] += priced.parts[key]
        entry.tokens.uncachedInputTokens += bucket.uncachedInputTokens
        entry.tokens.cacheReadTokens += bucket.cacheReadTokens
        entry.tokens.cacheWriteTokens += bucket.cacheWriteTokens
        entry.tokens.outputTokens += bucket.outputTokens
        entry.windows.add(bucket.window === 'peak' ? 'peak' : 'off')
        byModel.set(entry.model, entry)
      }
      return { total, byModel: [...byModel.values()], byWindow, unpriced, hasUnknown }
    }

    // ── 展示 ────────────────────────────────────────────────────────────────
    function currencySymbol(currency) {
      return currency === 'USD' ? '$' : '¥'
    }

    /** 金额：小额保留 4 位，大额 2 位；极小正值显示为 <0.0001。 */
    function formatMoney(amount, currency) {
      const symbol = currencySymbol(currency)
      if (typeof amount !== 'number' || !Number.isFinite(amount)) return `${symbol}—`
      if (amount === 0) return `${symbol}0`
      if (amount < 0) return `-${symbol}${Math.abs(amount).toFixed(2)}`
      if (amount < 0.0001) return `<${symbol}0.0001`
      return `${symbol}${amount.toFixed(amount < 1 ? 4 : 2)}`
    }

    /**
     * 平台钱包金额串 -> 平台网页一致的展示口径：两位小数、千分位分组，
     * 正数截断到分（不足一分显示 <0.01），负数四舍五入且最小显示 0.01。
     * 平台返回的是原始串（可能带一长串 0），所以这里按字符串处理避免浮点误差。
     * @param raw - 平台返回的余额串。
     * @returns 可直接展示的金额文本。
     */
    function formatPlatformAmount(raw) {
      const text = String(raw ?? '').trim()
      const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text)
      if (match === null) return text
      const negative = match[1] === '-'
      const whole = match[2]
      const fraction = match[3] ?? ''
      const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      const zeroWhole = /^0*$/.test(whole)
      if (!negative) {
        if (zeroWhole && /^0*$/.test(fraction)) return '0.00'
        const cents = fraction.slice(0, 2).padEnd(2, '0')
        if (zeroWhole && cents === '00') return '<0.01'
        return `${group(whole)}.${cents}`
      }
      // 负数：四舍五入到分，且显示幅度最小为 0.01
      const rounded = Number(whole) * 100 + Number(fraction.slice(0, 2).padEnd(2, '0')) + (Number(fraction[2] ?? '0') >= 5 ? 1 : 0)
      const magnitude = rounded === 0 ? 1 : rounded
      return `-${group(String(Math.floor(magnitude / 100)))}.${String(magnitude % 100).padStart(2, '0')}`
    }

    /** 平台余额字符串：货币符号 + 平台网页口径的金额。 */
    function formatWallet(balance, currency) {
      return `${currencySymbol(currency)}${formatPlatformAmount(balance)}`
    }

    function formatCount(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return value.toLocaleString('en-US')
    }

    function formatClock(ms) {
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /**
     * 读一个客户端服务：`ctx.get(name)` 是唯一带 undefined 语义的入口。
     * 直接写 `ctx.<name>` 对未注入的服务可能抛错（Cordis 的服务访问器），
     * 而渲染期抛错会让整个槽位条目被框架「abdicate」掉，所以这里一律走
     * get + try/catch，取不到就降级，不打断输入栏。
     */
    function safeGet(ctx, name) {
      try {
        if (typeof ctx.get === 'function') {
          const found = ctx.get(name)
          if (found !== undefined && found !== null) return found
        }
      } catch {
        /* get 不可用时继续尝试属性访问 */
      }
      try {
        return ctx[name]
      } catch {
        return undefined
      }
    }

    /**
     * 取当前 session 上 `deepseekCost` 的 projection face。
     * binding 只在已 retain 的会话上存在，且会话释放后访问会抛错，所以整段容错：
     * 取不到就让 chip 退回「只有余额」的形态，绝不打断输入栏渲染。
     */
    function readFace(ctx, sessionId) {
      try {
        if (sessionId === undefined) return undefined
        const sessions = safeGet(ctx, 'sessions')
        if (sessions === undefined) return undefined
        const binding = sessions.binding(sessionId)
        if (binding === undefined || binding.session === undefined) return undefined
        return binding.session.projections.faceOf(KEY)
      } catch {
        return undefined
      }
    }

    /** 观察一个 face（ObservableSnapshot）的当前值。 */
    function useFace(face) {
      const subscribe = React.useCallback(
        (onChange) => (face === undefined ? () => {} : face.subscribe(onChange)),
        [face],
      )
      const getSnapshot = React.useCallback(
        () => (face === undefined ? undefined : face.getSnapshot()),
        [face],
      )
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    /** 观察任意带 getSnapshot/subscribe 的源。 */
    function useSource(source) {
      const subscribe = React.useCallback(
        (onChange) => (source === undefined || source === null ? () => {} : source.subscribe(onChange)),
        [source],
      )
      const getSnapshot = React.useCallback(
        () => (source === undefined || source === null ? undefined : source.getSnapshot()),
        [source],
      )
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    /**
     * 取账号 Remote 命名空间。
     *
     * 网关把每个 Remote 命名空间装成**独立的 Cordis 服务** `remote.<namespace>`
     * （`RemoteNamespaceService` 用 `super(ctx, remoteServiceKey(name))`），并且
     * 服务只有被 inject 才可见——所以 `ctx.get('remote')` 取不到它。这里按
     * holder.account（可选注入拿到的服务）→ 逐条兜底 的顺序解析。
     */
    function accountNamespace(ctx, holder) {
      if (holder !== undefined && holder.account !== undefined && holder.account !== null) return holder.account
      try {
        const remote = safeGet(ctx, 'remote')
        const nested = remote === undefined || remote === null ? undefined : remote.account
        if (nested !== undefined && nested !== null && typeof nested.getBalance === 'function') return nested
      } catch {
        /* 继续尝试子服务名 */
      }
      const direct = safeGet(ctx, 'remote.account')
      return direct !== undefined && direct !== null && typeof direct.getBalance === 'function' ? direct : undefined
    }

    /**
     * 当前处于高峰还是空闲计费时段。
     *
     * 与 Host 半边的 `priceWindow` 同一口径（北京时间周一至周五 9:00-12:00、
     * 14:00-18:00 为高峰，法定节假日全天空闲）；Host 用事件时间给历史用量分桶，
     * 这里只用来看「此刻」该亮哪盏灯。
     */
    const CN_HOLIDAY_RANGES_2026 = [
      ['2026-01-01', '2026-01-03'],
      ['2026-02-15', '2026-02-23'],
      ['2026-04-04', '2026-04-06'],
      ['2026-05-01', '2026-05-05'],
      ['2026-06-19', '2026-06-21'],
      ['2026-09-25', '2026-09-27'],
      ['2026-10-01', '2026-10-07'],
    ]
    const CN_OFFSET_MS = 8 * 60 * 60 * 1000

    function beijingDateKey(ms) {
      const shifted = new Date(ms + CN_OFFSET_MS)
      const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
      const day = String(shifted.getUTCDate()).padStart(2, '0')
      return `${shifted.getUTCFullYear()}-${month}-${day}`
    }

    function currentPriceWindow(now) {
      const ms = now ?? Date.now()
      const shifted = new Date(ms + CN_OFFSET_MS)
      const weekday = shifted.getUTCDay()
      if (weekday === 0 || weekday === 6) return 'off'
      const dayStart = Date.parse(`${beijingDateKey(ms)}T00:00:00.000Z`)
      for (const [from, to] of CN_HOLIDAY_RANGES_2026) {
        if (dayStart >= Date.parse(`${from}T00:00:00.000Z`) && dayStart <= Date.parse(`${to}T00:00:00.000Z`)) return 'off'
      }
      const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
      return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60) ? 'peak' : 'off'
    }

    /** 账号 Remote 需要的调用方元数据。 */    function clientMetadata(locale) {
      let active = 'zh-CN'
      try {
        const snapshot = locale === undefined || locale === null ? undefined : locale.getSnapshot()
        if (snapshot !== undefined && typeof snapshot.active === 'string') active = snapshot.active
      } catch {
        /* 语言读取失败不影响余额查询 */
      }
      return {
        version: CLIENT_VERSION,
        locale: active,
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      }
    }

    /**
     * 解包 Remote 调用的结果信封。
     *
     * 客户端 Remote 方法返回的是 `RemoteResult<T>`：`{ ok: true, value }` 或
     * `{ ok: false, error }`（见 shipped 的 ui-settings-account：`if (!result.ok) ...`
     * 之后才读 `result.value`）。直接当裸值读会把成功结果误判成失败。
     * 未包装的形态（个别命名空间/未来版本）也兼容。
     */
    function unwrapRemote(result) {
      if (result !== null && typeof result === 'object' && typeof result.ok === 'boolean') {
        return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error }
      }
      return { ok: true, value: result }
    }

    /** 余额结果 -> 组件状态。 */
    function readBalance(result) {
      if (result === null || result === undefined) return { kind: 'signed-out' }
      if (result.status === 'ready') {
        return {
          kind: 'ready',
          wallets: Array.isArray(result.value) ? result.value : [],
          bonusWallets: Array.isArray(result.bonusWallets) ? result.bonusWallets : [],
        }
      }
      return { kind: 'failed', message: 'platform returned status=failed' }
    }

    /** 把未知异常压成一行可读文本（Remote 错误带 code）。 */
    function describeError(error) {
      if (error === undefined || error === null) return 'unknown error'
      const code = typeof error.code === 'string' ? error.code : undefined
      const message =
        typeof error.message === 'string' && error.message !== ''
          ? error.message
          : typeof error === 'string'
            ? error
            : String(error)
      return code === undefined ? message : `${code}: ${message}`
    }

    /** 从余额里推断计价货币：优先充值钱包，其次赠送钱包，缺省人民币。 */
    function currencyOf(balance) {
      if (balance !== undefined && balance.kind === 'ready') {
        const wallet = balance.wallets[0] ?? balance.bonusWallets[0]
        if (wallet !== undefined && (wallet.currency === 'USD' || wallet.currency === 'CNY')) return wallet.currency
      }
      return 'CNY'
    }

    /** 注入样式（每个 apply 生命周期一份）。 */
    function installStyles() {
      const id = 'dsh-deepseek-usage-meter/styles'
      if (document.getElementById(id) !== null) return () => {}
      const style = document.createElement('style')
      style.id = id
      style.textContent = `
.dsu-chip{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer;margin-left:-12px;padding-left:0}
.dsu-chip:hover,.dsu-chip[data-open="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);padding-left:8px;margin-left:-20px}
.dsu-light{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,currentColor)}
.dsu-light[data-window="off"]{background:var(--dsw-alias-state-success-primary,#2ea043)}
.dsu-light[data-window="peak"]{background:var(--dsw-alias-state-error-primary,#e5534b)}
.dsu-chip .dsu-strong,.dsu-chip .dsu-dim{font-variant-numeric:tabular-nums}
.dsu-chip .dsu-sep{color:var(--dsw-alias-separator-primary);margin:0 6px}
.dsu-panel{position:fixed;z-index:2147483000;min-width:264px;max-width:340px;padding:12px 14px;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-panel,0 12px 32px rgba(0,0,0,.18));backdrop-filter:var(--dsw-menu-backdrop-filter);font-size:12px;line-height:1.5}
.dsu-panel h4{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em}
.dsu-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.dsu-amount{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.01em;color:var(--dsw-alias-label-primary)}
.dsu-balance{font-size:13px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);text-align:right}
.dsu-muted{color:var(--dsw-alias-label-tertiary)}
.dsu-sub{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsu-rows{margin:10px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.dsu-row{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2)}
.dsu-row-top{display:flex;justify-content:space-between;gap:10px;font-variant-numeric:tabular-nums}
.dsu-row-model{font-weight:600;color:var(--dsw-alias-label-primary)}
.dsu-row-detail{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsu-sep{height:1px;margin:12px 0;background:var(--dsw-alias-border-l1)}
.dsu-wallet{display:flex;justify-content:space-between;gap:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.dsu-wallet .dsu-muted{color:var(--dsw-alias-label-tertiary)}
.dsu-foot{margin-top:10px;display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsu-error{margin-top:6px;max-height:88px;overflow:auto;padding:6px 8px;border-radius:var(--dsw-radius-md,8px);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d9483b) 12%,transparent);color:var(--dsw-alias-state-error-primary,#d9483b);font-size:11px;line-height:1.45;word-break:break-word}
.dsu-refresh{border:none;background:transparent;color:inherit;font:inherit;font-size:11px;cursor:pointer;padding:2px 6px;border-radius:999px}
.dsu-refresh:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
`
      document.head.appendChild(style)
      return () => {
        style.remove()
      }
    }

    /** 一行模型明细：列出各计费项目的金额；token 数退到悬停提示里。 */
    function ModelRow({ entry, currency, text }) {
      const windows = [...entry.windows]
      const peakLabel =
        windows.length > 1
          ? `${text.peak}/${text.off}`
          : windows[0] === 'peak'
            ? text.peak
            : text.off
      const tokens = entry.tokens
      const billedInput = tokens.uncachedInputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
      const hitRate = billedInput > 0 ? Math.round((tokens.cacheReadTokens / billedInput) * 100) : null
      // 各项目的金额（未缓存输入与缓存写入同价，但分开列，便于对账）
      const items = [
        [text.uncached, entry.costs.uncached, tokens.uncachedInputTokens],
        [text.cacheRead, entry.costs.cacheRead, tokens.cacheReadTokens],
        [text.cacheWrite, entry.costs.cacheWrite, tokens.cacheWriteTokens],
        [text.output, entry.costs.output, tokens.outputTokens],
      ].filter(([, amount, count]) => amount > 0 || count > 0)
      const detail = items.map(([label, amount]) => `${label} ${formatMoney(amount, currency)}`).join(' · ')
      const tooltip = items
        .map(([label, , count]) => `${label} ${formatCount(count)} ${text.tokens}`)
        .join(' · ')
      return h(
        'li',
        { className: 'dsu-row', title: tooltip },
        h(
          'div',
          { className: 'dsu-row-top' },
          h('span', { className: 'dsu-row-model' }, entry.model),
          h('span', null, `${formatMoney(entry.amount, currency)} · ${peakLabel}`),
        ),
        detail === '' ? null : h('div', { className: 'dsu-row-detail' }, detail),
        hitRate !== null ? h('div', { className: 'dsu-row-detail' }, `${text.cacheHit} ${hitRate}%`) : null,
      )
    }

    /**
     * 输入框工具栏的常驻指示器（实体）。
     * @param props - 框架注入的 session 标准 kit（至少含 sessionId）。
     */
    function UsageChipBody(props) {
      const sessionId = props.sessionId
      const ctx = props.ctxRef.ctx
      const locale = safeGet(ctx, 'locale')
      const text = pickText(useSource(locale)?.active)
      const face = readFace(ctx, sessionId)
      const usage = useFace(face)
      // 激活门控：Host 只在检测到 DeepSeek 官方渠道时才注册 `deepseekCost`，
      // 所以 projection 缺席就代表官方渠道不在场——此时整枚指示器不渲染，
      // 既不显示金额也不去查余额。另外，如果本会话确实有调用但全是非官方路由，
      // 同样不显示（避免在别家 provider 上看到一枚 ¥0 的指示器）。
      const buckets = Array.isArray(usage?.buckets) ? usage.buckets : []
      const hasOfficialUsage = buckets.some((bucket) => OFFICIAL_ROUTES.has(bucket.provider ?? null))
      const hasForeignUsage = buckets.some((bucket) => !OFFICIAL_ROUTES.has(bucket.provider ?? null))
      const active = usage !== undefined && usage !== null && (hasOfficialUsage || !hasForeignUsage)
      const [balance, setBalance] = React.useState({ kind: 'loading' })
      const [updatedAt, setUpdatedAt] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const chipRef = React.useRef(null)

      const loadBalance = React.useCallback(async () => {
        const account = accountNamespace(ctx, props.ctxRef)
        if (account === undefined) {
          setBalance({ kind: 'unavailable' })
          return
        }
        // 先读账号状态：它决定余额失败时该报「未登录」还是「平台调用失败」。
        let signedIn = false
        try {
          const stateResult = unwrapRemote(await account.getState())
          signedIn = stateResult.ok === true && stateResult.value !== null && stateResult.value !== undefined
            && stateResult.value.status === 'credential-stored'
        } catch {
          signedIn = false
        }
        try {
          const result = unwrapRemote(await account.getBalance(clientMetadata(locale)))
          if (!result.ok) {
            setBalance({ kind: 'failed', signedIn, message: describeError(result.error) })
            setUpdatedAt(Date.now())
            return
          }
          const parsed = readBalance(result.value)
          setBalance({ ...parsed, signedIn })
          setUpdatedAt(Date.now())
        } catch (error) {
          setBalance({ kind: 'failed', signedIn, message: describeError(error) })
          setUpdatedAt(Date.now())
        }
      }, [ctx, locale])

      React.useEffect(() => {
        if (!active) return undefined
        let live = true
        const run = () => {
          if (live) void loadBalance()
        }
        run()
        const timer = window.setInterval(run, BALANCE_REFRESH_MS)
        return () => {
          live = false
          window.clearInterval(timer)
        }
      }, [loadBalance, active])

      // 计费时段只在整点边界翻面：每分钟重算一次，空闲时红绿灯也不会停在旧状态。
      const [, setWindowTick] = React.useState(0)
      React.useEffect(() => {
        if (!active) return undefined
        const timer = window.setInterval(() => setWindowTick((value) => value + 1), 60_000)
        return () => window.clearInterval(timer)
      }, [active])

      const toggle = React.useCallback(() => {
        if (open) {
          setOpen(false)
          return
        }
        const rect = chipRef.current?.getBoundingClientRect()
        if (rect !== undefined) {
          setAnchor({
            right: Math.max(8, window.innerWidth - rect.right),
            bottom: Math.max(8, window.innerHeight - rect.top + 8),
          })
        }
        setOpen(true)
      }, [open])

      React.useEffect(() => {
        if (!open) return undefined
        const close = (event) => {
          if (chipRef.current !== null && chipRef.current.contains(event.target)) return
          if (event.target instanceof Element && event.target.closest('.dsu-panel') !== null) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onViewportChange = () => setOpen(false)
        document.addEventListener('mousedown', close, true)
        document.addEventListener('keydown', onKey, true)
        window.addEventListener('resize', onViewportChange)
        window.addEventListener('scroll', onViewportChange, true)
        return () => {
          document.removeEventListener('mousedown', close, true)
          document.removeEventListener('keydown', onKey, true)
          window.removeEventListener('resize', onViewportChange)
          window.removeEventListener('scroll', onViewportChange, true)
        }
      }, [open])

      // 未检测到官方渠道：整枚指示器不渲染（所有 hook 已按规定顺序执行完）。
      if (!active) return null

      const currency = currencyOf(balance)
      const summary = sumCost(buckets, currency)
      const windowNow = currentPriceWindow()
      const windowText = windowNow === 'peak' ? text.peak : text.off
      const totalTokens = TOKEN_FIELDS.reduce((sum, field) => sum + (usage?.totals?.[field] ?? 0), 0)
      const billedInput =
        (usage?.totals?.uncachedInputTokens ?? 0) +
        (usage?.totals?.cacheReadTokens ?? 0) +
        (usage?.totals?.cacheWriteTokens ?? 0)
      const hitRate = billedInput > 0 ? Math.round(((usage?.totals?.cacheReadTokens ?? 0) / billedInput) * 100) : null

      const walletLine = (wallet) =>
        h(
          'div',
          { className: 'dsu-wallet', key: `${wallet.currency}:${wallet.balance}` },
          h('span', { className: 'dsu-muted' }, text.toppedUp),
          h('span', null, formatWallet(wallet.balance, wallet.currency)),
        )
      const bonusLine = (wallet) =>
        h(
          'div',
          { className: 'dsu-wallet', key: `bonus:${wallet.currency}:${wallet.balance}` },
          h('span', { className: 'dsu-muted' }, text.granted),
          h('span', null, formatWallet(wallet.balance, wallet.currency)),
        )

      let balanceText
      if (balance.kind === 'ready') {
        const primary = balance.wallets[0]
        balanceText =
          primary !== undefined
            ? `${text.balance} ${formatWallet(primary.balance, primary.currency)}`
            : `${text.balance} —`
      } else if (balance.kind === 'loading') {
        balanceText = `${text.balance} ${text.loading}`
      } else if (balance.kind === 'signed-out') {
        balanceText = text.signedOut
      } else if (balance.kind === 'unavailable') {
        balanceText = text.unavailable
      } else {
        balanceText = text.failed
      }

      const panel =
        open && anchor !== null
          ? h(
              'div',
              { className: 'dsu-panel', style: { right: `${anchor.right}px`, bottom: `${anchor.bottom}px` } },
              h('h4', null, text.sessionCost),
              h(
                'div',
                { className: 'dsu-head' },
                h('div', { className: 'dsu-amount' }, formatMoney(summary.total, currency)),
                h('div', { className: 'dsu-balance' }, balanceText),
              ),
              h(
                'div',
                { className: 'dsu-sub' },
                // 会话总 token 数与缓存命中率由统计条的 token 用量常驻显示，这里不重复；
                // 只给统计条没有的信息：这次开销在高峰/空闲两档上的拆分。
                totalTokens === 0
                  ? text.noUsage
                  : summary.byWindow.peak > 0 && summary.byWindow.off > 0
                    ? `${text.peak} ${formatMoney(summary.byWindow.peak, currency)} · ${text.off} ${formatMoney(summary.byWindow.off, currency)}`
                    : summary.byWindow.peak > 0
                      ? `${text.peak} ${formatMoney(summary.byWindow.peak, currency)}`
                      : `${text.off} ${formatMoney(summary.byWindow.off, currency)}`,
              ),
              summary.byModel.length > 0
                ? h(
                    'ul',
                    { className: 'dsu-rows' },
                    summary.byModel.map((entry) =>
                      h(ModelRow, { key: entry.model, entry, currency, text }),
                    ),
                  )
                : null,
              summary.hasUnknown ? h('div', { className: 'dsu-sub' }, text.unknownModel) : null,
              summary.unpriced > 0 ? h('div', { className: 'dsu-sub' }, text.otherRoute) : null,
              h('div', { className: 'dsu-sep' }),
              h('h4', null, text.account),
              balance.kind === 'ready'
                ? h(
                    'div',
                    null,
                    balance.wallets.map(walletLine),
                    balance.bonusWallets.map(bonusLine),
                  )
                : h(
                    'div',
                    null,
                    h('div', { className: 'dsu-muted' }, balanceText),
                    balance.signedIn === true ? h('div', { className: 'dsu-sub' }, text.signedIn) : null,
                    balance.signedIn === false ? h('div', { className: 'dsu-sub' }, text.signOutState) : null,
                    typeof balance.message === 'string'
                      ? h('div', { className: 'dsu-error' }, balance.message)
                      : null,
                  ),
              h(
                'div',
                { className: 'dsu-foot' },
                h('span', null, updatedAt === null ? text.estimate : `${text.updated} ${formatClock(updatedAt)}`),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsu-refresh',
                    onClick: () => {
                      setBalance({ kind: 'loading' })
                      void loadBalance()
                    },
                  },
                  text.refresh,
                ),
              ),
            )
          : null

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            ref: chipRef,
            className: 'dsu-chip',
            'data-open': open ? 'true' : 'false',
            title: `${text.title} · ${windowText}`,
            'aria-label': `${text.title} · ${windowText}`,
            onClick: toggle,
          },
          h('span', { className: 'dsu-sep' }, '·'),
          h('span', { className: 'dsu-light', 'data-window': windowNow, 'aria-hidden': 'true' }),
          h('span', { className: 'dsu-strong' }, `≈${formatMoney(summary.total, currency)}`),
          h('span', { className: 'dsu-sep' }, '·'),
          h('span', { className: 'dsu-dim' }, balanceText),
        ),
        panel,
      )
    }

    /**
     * 一条槽位条目一旦在渲染期抛错，框架就会把它「abdicate」掉并且不再恢复，
     * 所以指示器外面必须有自己的错误边界：出问题时只让这枚 chip 消失，
     * 不影响输入栏，也不会把条目本身赔进去。
     */
    class UsageChipBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        console.error('dsh-deepseek-usage-meter: 指示器渲染失败，已隐藏', error)
      }

      render() {
        if (this.state.failed) return null
        return h(UsageChipBody, this.props)
      }
    }

    /** 客户端服务依赖。 */
    const inject = ['slots', 'sessions']

    /**
     * 客户端插件入口：注册输入栏指示器。
     * @param ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      const styles = installStyles()
      ctx.effect(() => styles, 'dsh-deepseek-usage-meter: styles')
      const holder = { ctx }
      // Remote 命名空间是独立服务，只有注入才可见；用可选注入拿到账号命名空间，
      // 拿不到也不阻塞插件——指示器仍会显示开销，余额在服务就绪后的下一次刷新补上。
      ctx.inject(['remote.account'], (scope) => {
        const candidates = []
        try {
          if (typeof scope.get === 'function') candidates.push(scope.get('remote.account'))
        } catch {
          /* 继续尝试其它读法 */
        }
        try {
          candidates.push(scope['remote.account'])
        } catch {
          /* 继续尝试其它读法 */
        }
        try {
          candidates.push(scope.remote === undefined || scope.remote === null ? undefined : scope.remote.account)
        } catch {
          /* 读不到就只显示开销 */
        }
        const account = candidates.find(
          (candidate) => candidate !== undefined && candidate !== null && typeof candidate.getBalance === 'function',
        )
        if (account !== undefined) holder.account = account
      })
      // 并进输入框下方那条统计条：composer.dock 是横排 flex（居中、gap 12px），
      // 所以只要注册进同一个槽位就与「token 用量」同行，order 让它排在 statistics 之后。
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'deepseek-usage-meter',
            order: 10,
          },
          (props) => h(UsageChipBoundary, { ...props, ctxRef: holder }),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    // 供离线校验计价口径（不影响客户端插件契约）。
    exports.__internal = {
      PRICES,
      priceFor,
      bucketCost,
      sumCost,
      formatMoney,
      formatWallet,
      formatPlatformAmount,
      currentPriceWindow,
      normalizeModel,
    }
    return module.exports
  },
})
