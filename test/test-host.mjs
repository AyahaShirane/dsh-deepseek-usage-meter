/**
 * Host 半边离线校验：直接驱动 projection 定义，检查折叠语义。
 * 运行： node test/test-host.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

let registered = null
let registrations = 0
let disposals = 0
/** 可切换的假 llm 服务：验证「只在检测到 DeepSeek 官方渠道时激活」。 */
let providers = []
const listeners = new Map()

const scope = {
  sessionProjections: {
    register: (definition) => {
      registered = definition
      registrations += 1
      return () => {
        registered = null
        disposals += 1
      }
    },
  },
  get: (name) => (name === 'llm' ? { listProviders: () => providers } : undefined),
  on: (event, handler) => {
    listeners.set(event, handler)
    return () => listeners.delete(event)
  },
  effect: (factory) => factory(),
}
apply({ inject: (deps, callback) => callback(scope) })

// ── 激活门控 ──────────────────────────────────────────────────────────────
assert.equal(registrations, 0, '没有任何官方路由时不得注册 projection')
providers = [{ id: 'openai', name: 'OpenAI' }]
listeners.get('llm/adapters-updated')()
assert.equal(registrations, 0, '只有别家 provider 时不得注册')

providers = [{ id: 'deepseek-account', name: 'DeepSeek' }]
listeners.get('llm/adapters-updated')()
assert.equal(registrations, 1, '检测到官方账号渠道后应注册')

const captured = registered
assert.ok(captured !== null, 'apply() 必须注册 projection')
assert.equal(captured.key, 'deepseekCost')
assert.equal(captured.stateVersion, 1)
assert.equal(typeof captured.apply, 'function')
assert.ok(captured.wire !== undefined, 'projection 必须带 wire 块才对客户端可见')

providers = [{ id: 'openai', name: 'OpenAI' }, { id: 'anthropic', name: 'Anthropic' }]
listeners.get('llm/adapters-updated')()
assert.equal(disposals, 1, '官方路由消失后应摘掉 registration')
assert.equal(registered, null)

providers = [{ id: 'deepseek-official', name: 'DeepSeek API Key' }]
listeners.get('llm/adapters-updated')()
assert.equal(registrations, 2, '官方 API Key 渠道同样应激活')

providers = [{ id: 'deepseek-official', name: 'DeepSeek API Key' }]
listeners.get('llm/adapters-updated')()
assert.equal(registrations, 2, '门控是幂等的：路由没变不得重复注册')

/** 事件构造：北京时间 -> epoch 毫秒。 */
const beijing = (iso, hour, minute = 0) => Date.parse(`${iso}T00:00:00.000Z`) + (hour * 60 + minute) * 60000 - 8 * 3600000

const header = (provider, model) => ({
  type: 'request/header',
  time: Date.now(),
  data: { header: { config: { provider, model } } },
})
const settlement = (turn, step, time, usage) => ({
  type: 'assistant/message',
  time,
  data: { turn, step, usage },
})

// 1. 初始态
let state = captured.init({}, 0)
assert.deepEqual(captured.wire.view(state).totals, {
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
})

// 2. 无关事件必须返回同一引用（Object.is 变化门）
const before = state
state = captured.apply(state, { type: 'turn/start', time: Date.now(), data: { turn: 1 } })
assert.equal(state, before, '无关事件必须返回同一 state 引用')

// 3. 路由 + 高峰时段（北京时间 2026-10-12 周一 10:00 属高峰；10-05 在国庆假期内，见第 6 项）
state = captured.apply(state, header('deepseek-account', 'deepseek-flash'))
assert.equal(state.provider, 'deepseek-account')
assert.equal(state.model, 'deepseek-flash')

const peakTime = beijing('2026-10-12', 10, 0)
state = captured.apply(
  state,
  settlement(1, 1, peakTime, { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
)
let view = captured.wire.view(state)
assert.equal(view.buckets.length, 1)
assert.equal(view.buckets[0].window, 'peak', '周一 10:00 应为高峰时段')
assert.equal(view.totals.uncachedInputTokens, 1_000_000)
assert.equal(view.totals.outputTokens, 1_000_000)

// 4. 同一 turn/step 的重放结算必须替换而不是累加
state = captured.apply(
  state,
  settlement(1, 1, peakTime, { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 5 }),
)
view = captured.wire.view(state)
assert.equal(view.totals.cacheReadTokens, 5)
assert.equal(view.totals.uncachedInputTokens, 1_000_000, '重放不得重复计费')

// 5. 空闲时段（北京时间周日）落进另一个桶
const offTime = beijing('2026-10-11', 10, 0) // 周日
state = captured.apply(state, settlement(2, 1, offTime, { inputTokens: 10, outputTokens: 20 }))
view = captured.wire.view(state)
assert.equal(view.buckets.length, 2, '高峰与空闲必须分桶')
assert.equal(view.totals.outputTokens, 1_000_020)

// 6. 法定节假日全天按空闲价：2026-10-01 周四 10:00 属国庆假期
let holidayState = captured.init({}, 0)
holidayState = captured.apply(holidayState, header('deepseek-account', 'deepseek-v4-pro'))
holidayState = captured.apply(
  holidayState,
  settlement(1, 1, beijing('2026-10-01', 10, 0), { inputTokens: 1, outputTokens: 1 }),
)
assert.equal(captured.wire.view(holidayState).buckets[0].window, 'off', '国庆假期应为空闲时段')

// 7. llm/retry-started 之后重新计费
state = captured.apply(state, { type: 'llm/retry-started', time: peakTime, data: { turn: 2, step: 1 } })
state = captured.apply(state, settlement(2, 1, offTime, { inputTokens: 10, outputTokens: 20 }))
view = captured.wire.view(state)
assert.equal(view.totals.outputTokens, 1_000_040, '重试后的第二次尝试应再次计入')

// 8. 模型切换写进新桶
state = captured.apply(state, header('deepseek-account', 'deepseek-v4-pro'))
state = captured.apply(state, settlement(3, 1, offTime, { inputTokens: 7, outputTokens: 9 }))
view = captured.wire.view(state)
assert.equal(view.buckets.length, 3, '不同模型必须分桶')
assert.equal(view.model, 'deepseek-v4-pro')

// 9. 视图引用稳定：同一 state 两次取值必须同一对象（注册表的 Object.is 门）
assert.equal(captured.wire.view(state), captured.wire.view(state))

// 10. 流式回落到最后一个 usage 分片
let streamState = captured.init({}, 0)
streamState = captured.apply(streamState, header('deepseek-official', 'deepseek-flash'))
streamState = captured.apply(streamState, {
  type: 'assistant/attempt',
  time: offTime,
  data: {
    turn: 1,
    step: 1,
    stream: [
      { type: 'text', text: 'hi' },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } },
    ],
  },
})
assert.equal(captured.wire.view(streamState).totals.outputTokens, 4)

console.log('host fold: 全部断言通过')
