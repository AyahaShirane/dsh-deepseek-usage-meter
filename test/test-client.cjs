/**
 * 浏览器半边离线校验：用假的 __ModuleLoader__ + react 桩加载 bundle，
 * 检查计价口径与金额格式化。运行： node tools/test-client.cjs
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load: (row) => {
      captured = row
    },
  },
}

const bundle = path.join(__dirname, '..', 'lib', 'client.js')
// bundle 是 lazy-CJS 工厂：没有 import/export，可以直接按 CJS 求值。
new Function(fs.readFileSync(bundle, 'utf8'))()

assert.ok(captured !== null, 'bundle 必须调用 window.__ModuleLoader__.load')
assert.equal(captured.id, 'dsh-deepseek-usage-meter', 'bundle id 必须等于包名')

class Component {
  constructor(props) {
    this.props = props
    this.state = {}
  }
  setState(next) {
    this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
  }
}
Component.prototype.isReactComponent = {}

const reactStub = {
  createElement: () => null,
  Fragment: Symbol('Fragment'),
  Component,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
  useSyncExternalStore: () => undefined,
}
const exportsObject = captured.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error(`unexpected require(${name})`)
})

assert.equal(typeof exportsObject.apply, 'function')
assert.deepEqual(exportsObject.inject, ['slots', 'sessions'], '客户端服务注入必须包含 slots/sessions')

const { sumCost, formatMoney, priceFor, formatWallet, formatPlatformAmount } = exportsObject.__internal

const buckets = (provider, model, window, tokens) => ({
  provider,
  model,
  window,
  uncachedInputTokens: tokens.uncached ?? 0,
  cacheReadTokens: tokens.read ?? 0,
  cacheWriteTokens: tokens.write ?? 0,
  outputTokens: tokens.out ?? 0,
})

// 1. flash 空闲价：1M 未缓存输入 ¥1 + 1M 输出 ¥4 = ¥5
let result = sumCost([buckets('deepseek-account', 'deepseek-flash', 'off', { uncached: 1e6, out: 1e6 })], 'CNY')
assert.equal(Number(result.total.toFixed(6)), 5)

// 2. flash 高峰价翻倍：¥2 + ¥8 = ¥10
result = sumCost([buckets('deepseek-account', 'deepseek-flash', 'peak', { uncached: 1e6, out: 1e6 })], 'CNY')
assert.equal(Number(result.total.toFixed(6)), 10)

// 3. v4-pro 空闲价：1M 未缓存 ¥4.5 + 1M 输出 ¥13.5 = ¥18
result = sumCost([buckets('deepseek-account', 'deepseek-v4-pro', 'off', { uncached: 1e6, out: 1e6 })], 'CNY')
assert.equal(Number(result.total.toFixed(6)), 18)

// 4. 缓存命中按命中价：1M 命中 ¥0.02（flash 空闲）
result = sumCost([buckets('deepseek-account', 'deepseek-flash', 'off', { read: 1e6 })], 'CNY')
assert.equal(Number(result.total.toFixed(6)), 0.02)

// 5. 缓存写入按未命中价计入
result = sumCost([buckets('deepseek-account', 'deepseek-flash', 'off', { write: 1e6 })], 'CNY')
assert.equal(Number(result.total.toFixed(6)), 1)

// 6. USD 官方价（不是汇率换算）
result = sumCost([buckets('deepseek-account', 'deepseek-flash', 'off', { uncached: 1e6, out: 1e6 })], 'USD')
assert.equal(Number(result.total.toFixed(6)), 0.75)

// 7. 旧模型名归并到 flash 价
assert.equal(priceFor('deepseek-v4-flash', 'CNY', 'off').miss, 1)
assert.equal(priceFor('deepseek-v4-flash', 'CNY', 'off').known, true)

// 8. 未知模型按 flash 计并标记
const unknown = priceFor('some-future-model', 'CNY', 'off')
assert.equal(unknown.known, false)
assert.equal(unknown.miss, 1)

// 9. 非官方渠道不计价，只统计 token
result = sumCost([buckets('openai', 'gpt-x', 'off', { uncached: 1e6, out: 1e6 })], 'CNY')
assert.equal(result.total, 0)
assert.equal(result.unpriced, 2e6)

// 10. 分模型汇总
result = sumCost(
  [
    buckets('deepseek-account', 'deepseek-flash', 'off', { uncached: 1e6 }),
    buckets('deepseek-account', 'deepseek-flash', 'peak', { uncached: 1e6 }),
    buckets('deepseek-account', 'deepseek-v4-pro', 'off', { out: 1e6 }),
  ],
  'CNY',
)
assert.equal(result.byModel.length, 2)
assert.equal(Number(result.byModel.find((entry) => entry.model === 'deepseek-flash').amount.toFixed(6)), 3)
assert.equal(Number(result.byModel.find((entry) => entry.model === 'deepseek-v4-pro').amount.toFixed(6)), 13.5)
assert.equal(Number(result.total.toFixed(6)), 16.5)

// 11. 金额格式化
assert.equal(formatMoney(0, 'CNY'), '¥0')
assert.equal(formatMoney(0.01234, 'CNY'), '¥0.0123')
assert.equal(formatMoney(45.678, 'CNY'), '¥45.68')
assert.equal(formatMoney(0.00001, 'CNY'), '<¥0.0001')
assert.equal(formatMoney(1.5, 'USD'), '$1.50')

// 12. 平台钱包金额：两位小数、千分位、正数截断到分、次分显示 <0.01
assert.equal(formatPlatformAmount('141.8000000000'), '141.80')
assert.equal(formatPlatformAmount('1234.5678'), '1,234.56')
assert.equal(formatPlatformAmount('0'), '0.00')
assert.equal(formatPlatformAmount('0.0000000001'), '<0.01')
assert.equal(formatPlatformAmount('45.67'), '45.67')
assert.equal(formatPlatformAmount('7'), '7.00')
assert.equal(formatWallet('141.8000000000', 'CNY'), '¥141.80')
assert.equal(formatWallet('12.5', 'USD'), '$12.50')
assert.equal(formatWallet('0.004', 'CNY'), '¥<0.01')

// 13. 红绿灯时段判定（北京时间；与 Host 分桶同一口径）
const { currentPriceWindow } = exportsObject.__internal
const at = (iso, hour, minute = 0) => Date.parse(`${iso}T00:00:00.000Z`) + (hour * 60 + minute) * 60000 - 8 * 3600000
assert.equal(currentPriceWindow(at('2026-10-12', 10)), 'peak', '周一 10:00 应为高峰')
assert.equal(currentPriceWindow(at('2026-10-12', 13)), 'off', '午休应为空闲')
assert.equal(currentPriceWindow(at('2026-10-12', 15)), 'peak', '周一 15:00 应为高峰')
assert.equal(currentPriceWindow(at('2026-10-11', 10)), 'off', '周日应为空闲')
assert.equal(currentPriceWindow(at('2026-10-01', 10)), 'off', '国庆假期应为空闲')

console.log('client pricing: 全部断言通过')
