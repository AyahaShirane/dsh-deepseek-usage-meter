/**
 * DeepSeek 官方渠道开销计量 —— Host 半边。
 *
 * 只做一件事：注册一个客户端可见的 session projection `deepseekCost`，把会话
 * 日志里「哪一次请求用了哪个 provider/model」与「提供方回报的 token 用量」折
 * 进同一份账本，并保留该次用量落在 DeepSeek 官方高峰/空闲计费时段中的哪一档。
 *
 * 金额计算刻意留在浏览器半边：价格表、货币、展示都属于 UI 决策，Host 只提供
 * 可验证的事实（provider、model、时段、四类 token 数）。
 *
 * 本文件不 import 任何包：插件被安装进 profile 后不会带来额外的依赖解析，
 * 因此也不会有版本兼容问题。
 */

/** projection key —— 客户端通过 session.projections.faceOf(key) 读取。 */
const KEY = 'deepseekCost'

/** 状态结构或折叠语义变化时递增；注册表用它拒绝复用旧 checkpoint。 */
const STATE_VERSION = 1

/** 桶字段：与 provider 回报的 TokenUsage 一一对应。 */
const BUCKET_FIELDS = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']

/** 空白账本（不可变，供 init 复用）。 */
const EMPTY_TOTALS = Object.freeze({
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
})

/** schema 的鸭子类型替身：注册表只调用 .parse(v)。 */
const passthrough = Object.freeze({ parse: (value) => value })

/** 视图缓存：state -> view，保证 view(state) 引用稳定（Object.is 变化门）。 */
const viewCache = new WeakMap()

/** 北京时间偏移（DeepSeek 官方价格以北京时间为准：周一至周五 9:00-12:00、14:00-18:00 为高峰）。 */
const CN_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * 中国法定节假日（国务院办公厅 2026 年安排），高峰时段在这些日期全天让位于空闲价。
 * 仅影响「高峰/空闲」标注；跨年时把新一年的安排补进来即可。
 */
const CN_HOLIDAY_RANGES_2026 = Object.freeze([
  ['2026-01-01', '2026-01-03'], // 元旦
  ['2026-02-15', '2026-02-23'], // 春节
  ['2026-04-04', '2026-04-06'], // 清明节
  ['2026-05-01', '2026-05-05'], // 劳动节
  ['2026-06-19', '2026-06-21'], // 端午节
  ['2026-09-25', '2026-09-27'], // 中秋节
  ['2026-10-01', '2026-10-07'], // 国庆节
])

/** 北京时间的 YYYY-MM-DD。 */
function beijingDateKey(ms) {
  const shifted = new Date(ms + CN_OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 北京时间这一天的 0 点（用于与节假日区间做闭区间比较）。 */
function beijingMidnight(key) {
  return Date.parse(`${key}T00:00:00.000Z`)
}

/**
 * 判断一次用量发生的时刻是否落在 DeepSeek 官方高峰计费时段。
 * 规则：北京时间周一至周五 9:00-12:00、14:00-18:00，法定节假日除外。
 * @param ms - 会话事件的 time（epoch 毫秒）。
 * @returns 'peak' | 'off'。
 */
function priceWindow(ms) {
  if (!Number.isFinite(ms)) return 'off'
  const shifted = new Date(ms + CN_OFFSET_MS)
  const weekday = shifted.getUTCDay() // 0=周日
  if (weekday === 0 || weekday === 6) return 'off'
  const dateKey = beijingDateKey(ms)
  const dayStart = beijingMidnight(dateKey)
  for (const [from, to] of CN_HOLIDAY_RANGES_2026) {
    if (dayStart >= beijingMidnight(from) && dayStart <= beijingMidnight(to)) return 'off'
  }
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  const morning = minutes >= 9 * 60 && minutes < 12 * 60
  const afternoon = minutes >= 14 * 60 && minutes < 18 * 60
  return morning || afternoon ? 'peak' : 'off'
}

/** 提供方回报的用量 -> 四个计数桶；缺字段按 0 计。 */
function bucketsFrom(usage) {
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  return {
    uncachedInputTokens: num(usage.inputTokens),
    cacheReadTokens: num(usage.cacheReadTokens),
    cacheWriteTokens: num(usage.cacheWriteTokens),
    outputTokens: num(usage.outputTokens),
  }
}

/** 是否为空桶。 */
function isZeroBuckets(buckets) {
  return BUCKET_FIELDS.every((field) => buckets[field] === 0)
}

/** 两个桶是否完全一致（用于抑制无意义的发布）。 */
function sameBuckets(left, right) {
  return left !== null && right !== null && BUCKET_FIELDS.every((field) => left[field] === right[field])
}

/**
 * 取一个 assistant 结算事件携带的提供方用量。
 * assistant/message 直接带 usage；assistant/attempt 与流式结算回落到最后一个
 * type === 'usage' 的流分片 —— 与 dsh-token-meter 的取法一致。
 */
function usageOf(event) {
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  if (data.usage !== null && typeof data.usage === 'object') return data.usage
  const stream = data.stream
  const chunks = Array.isArray(stream)
    ? stream
    : stream !== null && typeof stream === 'object' && Array.isArray(stream.chunks)
      ? stream.chunks
      : null
  if (chunks === null) return undefined
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index]
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage' && chunk.usage) return chunk.usage
  }
  return undefined
}

/** 账本行 key：provider + model + 计费时段。 */
function rowKey(provider, model, window) {
  return `${provider ?? ''}\u0000${model ?? ''}\u0000${window}`
}

/** 在行账本上做增量写（返回新对象，保持不可变语义）。 */
function addToRows(rows, key, buckets, sign) {
  const current = rows[key] ?? EMPTY_TOTALS
  const next = {}
  for (const field of BUCKET_FIELDS) next[field] = current[field] + sign * buckets[field]
  const updated = { ...rows }
  if (isZeroBuckets(next)) delete updated[key]
  else updated[key] = next
  return updated
}

/** 折叠出 wire 视图：客户端只需要事实，不需要金额。 */
function buildView(state) {
  const split = (key) => key.split('\u0000')
  const buckets = Object.keys(state.rows).map((key) => {
    const [provider, model, window] = split(key)
    return { provider, model, window, ...state.rows[key] }
  })
  buckets.sort((left, right) =>
    left.model === right.model
      ? left.window.localeCompare(right.window)
      : left.model.localeCompare(right.model),
  )
  const totals = { ...EMPTY_TOTALS }
  for (const bucket of buckets) {
    for (const field of BUCKET_FIELDS) totals[field] += bucket[field]
  }
  return {
    model: state.model,
    provider: state.provider,
    buckets,
    totals,
    // 计费时段标注所用的规则版本，客户端展示时用来解释口径。
    windowRule: 'cn-beijing-weekday-peak',
  }
}

/**
 * 视图引用缓存：注册表用 Object.is 判断是否发布，同一个 state 必须给出同一个 view。
 */
function viewOf(state) {
  let view = viewCache.get(state)
  if (view === undefined) {
    view = buildView(state)
    viewCache.set(state, view)
  }
  return view
}

/** projection 定义 —— 契约见 @deepseek-ai/dsh-session-projection。 */
const definition = {
  key: KEY,
  stateVersion: STATE_VERSION,
  stateSchema: passthrough,
  init: () => ({ provider: null, model: null, rows: {}, last: null }),
  apply: (state, event) => {
    if (event.type === 'llm/retry-started') {
      const last = state.last
      if (last !== null && last.turn === event.data.turn && last.step === event.data.step) {
        return { ...state, last: null }
      }
      return state
    }

    if (event.type === 'request/header') {
      const config = event.data?.header?.config
      const provider = typeof config?.provider === 'string' ? config.provider : null
      const model = typeof config?.model === 'string' ? config.model : null
      if (provider === state.provider && model === state.model) return state
      return { ...state, provider, model }
    }

    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state

    const usage = usageOf(event)
    if (usage === undefined) return state
    const buckets = bucketsFrom(usage)
    if (isZeroBuckets(buckets)) return state

    const { turn, step } = event.data
    const window = priceWindow(event.time)
    const key = rowKey(state.provider, state.model, window)
    const previous = state.last
    const replaces =
      previous !== null && previous.turn === turn && previous.step === step ? previous : null
    // 同一步骤内的重放/重试结算：先扣掉旧值再记新值，避免重复计费。
    if (replaces !== null && replaces.rowKey === key && sameBuckets(replaces.buckets, buckets)) return state

    let rows = state.rows
    if (replaces !== null) rows = addToRows(rows, replaces.rowKey, replaces.buckets, -1)
    rows = addToRows(rows, key, buckets, 1)
    return { ...state, rows, last: { turn, step, rowKey: key, buckets } }
  },
  wire: {
    viewSchema: passthrough,
    view: (state) => viewOf(state),
  },
}

/**
 * 属于 DeepSeek 官方渠道的 provider 路由。
 * `deepseek-official` 是官方 API Key 渠道，`deepseek-account` 是官方账号渠道。
 */
const OFFICIAL_ROUTES = Object.freeze(['deepseek-official', 'deepseek-account'])

/**
 * 当前 composition 里是否挂载了 DeepSeek 官方渠道。
 *
 * 判定依据是 `llm.listProviders()`——它列出所有「已注册适配器」的路由，
 * 与具体用哪把 Key、是否登录无关。没有任何官方路由时（例如整套换成别家 provider），
 * 插件完全不激活：不注册 projection，客户端也就没有任何东西可渲染。
 * @param scope - 已注入 sessionProjections 的作用域。
 * @returns 是否存在官方渠道路由。
 */
function officialRoutePresent(scope) {
  try {
    const llm = typeof scope.get === 'function' ? scope.get('llm') : undefined
    if (llm === undefined || llm === null || typeof llm.listProviders !== 'function') return false
    const providers = llm.listProviders()
    if (!Array.isArray(providers)) return false
    return providers.some(
      (entry) => entry !== null && typeof entry === 'object' && OFFICIAL_ROUTES.includes(entry.id),
    )
  } catch {
    return false
  }
}

/**
 * Host 插件入口：检测到 DeepSeek 官方渠道时注册账本 projection。
 *
 * - `sessionProjections` 用可选注入，缺少注册表时插件保持惰性而不阻塞其它行；
 * - 路由在运行期可能增减（改配置、换 provider），所以监听 `llm/adapters-updated`
 *   动态挂上/摘下 registration，而不是只在激活那一刻判定一次。
 * @param ctx - Host cordis 上下文。
 */
export function apply(ctx) {
  ctx.inject(['sessionProjections'], (scope) => {
    let disposeProjection = null

    const sync = () => {
      const present = officialRoutePresent(scope)
      if (present && disposeProjection === null) {
        disposeProjection = scope.sessionProjections.register(definition)
      } else if (!present && disposeProjection !== null) {
        const release = disposeProjection
        disposeProjection = null
        release()
      }
    }

    scope.effect(() => {
      sync()
      const off = scope.on('llm/adapters-updated', sync)
      return () => {
        off()
        if (disposeProjection !== null) {
          const release = disposeProjection
          disposeProjection = null
          release()
        }
      }
    }, 'dsh-deepseek-usage-meter: DeepSeek 官方渠道门控')
  })
}

export const name = 'dsh-deepseek-usage-meter'
