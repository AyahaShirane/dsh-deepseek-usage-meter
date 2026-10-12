/**
 * 组件渲染校验：用最小 hook 运行时真正执行浏览器半边的组件，
 * 捕获 abdication（渲染期抛错）的真实原因。
 * 运行： node tools/test-render.cjs
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// ── 最小 React 运行时 ──────────────────────────────────────────────────────
let hookIndex = 0
let stateIndex = 0
let hookState = []
let overrideState = {}
/** 序列化元素树，函数/符号压成占位符，便于断言渲染结果。 */
function stringify(value) {
  return JSON.stringify(value, (key, item) =>
    typeof item === 'function' ? '[fn]' : typeof item === 'symbol' ? '[sym]' : item,
  )
}
const React = {
  Fragment: Symbol('react.fragment'),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => {
    const index = `state${stateIndex++}`
    const forced = overrideState[index]
    if (forced !== undefined) hookState[index] = forced
    else if (hookState[index] === undefined) hookState[index] = initial
    return [hookState[index], (next) => { hookState[index] = typeof next === 'function' ? next(hookState[index]) : next }]
  },
  useRef: (initial) => {
    const index = hookIndex++
    if (hookState[index] === undefined) hookState[index] = { current: initial }
    return hookState[index]
  },
  useCallback: (fn) => {
    hookIndex += 1
    return fn
  },
  useEffect: (fn) => {
    const index = hookIndex++
    hookState[index] = fn
  },
  useSyncExternalStore: (subscribe, getSnapshot) => {
    hookIndex += 1
    subscribe(() => {})
    return getSnapshot()
  },
}
const effects = []
React.useEffect = (fn) => {
  const index = hookIndex++
  effects.push(fn)
}
// 类组件基类（错误边界用）
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
React.Component = Component

// ── DOM / window 桩 ────────────────────────────────────────────────────────
const intervals = []
globalThis.document = {
  head: { appendChild: () => {} },
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '', remove: () => {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
}
globalThis.window = {
  __ModuleLoader__: { load: (row) => { globalThis.__row = row } },
  setInterval: (fn) => { intervals.push(fn); return intervals.length },
  clearInterval: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  innerWidth: 1200,
  innerHeight: 800,
}
globalThis.navigator = { language: 'zh-CN' }
globalThis.Element = class Element {}

// ── 加载 bundle ───────────────────────────────────────────────────────────
const bundle = path.join(__dirname, '..', 'lib', 'client.js')
new Function(fs.readFileSync(bundle, 'utf8'))()
const row = globalThis.__row
assert.equal(row.id, 'dsh-deepseek-usage-meter')

const wireView = {
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  buckets: [
    {
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      window: 'off',
      uncachedInputTokens: 166203,
      cacheReadTokens: 15240064,
      cacheWriteTokens: 0,
      outputTokens: 93672,
    },
  ],
  totals: {
    uncachedInputTokens: 166203,
    cacheReadTokens: 15240064,
    cacheWriteTokens: 0,
    outputTokens: 93672,
  },
  windowRule: 'cn-beijing-weekday-peak',
}
/** session 上的 `deepseekCost` face；快照可切换，用来驱动激活门控的断言。 */
let faceValue = wireView
const face = { getSnapshot: () => faceValue, subscribe: () => () => {} }
let registered = null
let balanceCalls = 0
/** 假的 remote.account 命名空间服务（网关把它装成独立的 Cordis 服务）。
 *  客户端 Remote 方法按契约返回 RemoteResult 信封。 */
let balanceShouldThrow = null
let balanceFailure = null
const accountService = {
  getState: async () => ({
    ok: true,
    value: { status: 'credential-stored', links: { usageUrl: 'u', topUpUrl: 't' }, attempt: null },
  }),
  getBalance: async () => {
    balanceCalls += 1
    if (balanceShouldThrow !== null) throw balanceShouldThrow
    if (balanceFailure !== null) return { ok: false, error: balanceFailure }
    return {
      ok: true,
      value: {
        status: 'ready',
        value: [{ currency: 'CNY', balance: '45.67' }],
        bonusWallets: [{ currency: 'CNY', balance: '2.00' }],
      },
    }
  },
}
const injectCalls = []
const ctx = {
  locale: { getSnapshot: () => ({ active: 'zh-CN' }), subscribe: () => () => {} },
  sessions: { binding: () => ({ session: { projections: { faceOf: () => face } } }) },
  // 故意不提供 ctx.remote：验证「可选注入 remote.account」这条路才是生效的那条。
  get: () => undefined,
  inject: (deps, callback) => {
    injectCalls.push({ deps, callback })
  },
  slots: {
    inject: (key, callback) => {
      assert.equal(key, 'conversation.composer.dock', 'indicators 必须并进输入框下方的统计条槽位')
      callback()
    },
    register: (descriptor, component) => {
      assert.equal(descriptor.name, 'conversation.composer.dock')
      assert.equal(descriptor.id, 'deepseek-usage-meter')
      assert.ok(descriptor.order > 0, 'order 必须排在 stats（order 0）之后')
      registered = component
      return () => {}
    },
  },
  effect: (fn) => fn(),
}

const exportsObject = row.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})
exportsObject.apply(ctx)
assert.ok(registered !== null, '应当注册槽位组件')
// 模拟 Cordis 在 remote.account 服务就绪后执行可选注入
assert.equal(injectCalls.length, 1, '应当声明一条 remote.account 可选注入')
assert.deepEqual(injectCalls[0].deps, ['remote.account'])
injectCalls[0].callback({ get: (name) => (name === 'remote.account' ? accountService : undefined) })

// ── 渲染（面板关闭） ───────────────────────────────────────────────────────
/** 递归展开函数/类组件，得到宿主元素树（hook 运行时在同一轮渲染内共享）。 */
function renderDeep(element) {
  if (Array.isArray(element)) return element.map(renderDeep)
  if (element === null || element === undefined || typeof element !== 'object') return element
  if (typeof element.type === 'function') {
    if (element.type.prototype !== undefined && element.type.prototype.isReactComponent !== undefined) {
      const instance = new element.type(element.props)
      return renderDeep(instance.render())
    }
    return renderDeep(element.type(element.props))
  }
  const children = (element.children ?? []).map(renderDeep)
  return { ...element, children }
}

/** 开始一轮渲染：hook 游标复位；keep=true 时保留上一轮的状态（用于读取异步写入的余额）。 */
function beginRender(overrides, keep) {
  hookIndex = 0
  stateIndex = 0
  effects.length = 0
  if (keep !== true) hookState = []
  overrideState = overrides ?? {}
}

function render(props, overrides, keep) {
  beginRender(overrides, keep)
  return renderDeep(
    registered({ sessionId: 'session-x', useProjection: (key) => (key === 'deepseekCost' ? wireView : undefined), ...props }),
  )
}

/** 面板打开态：useState 顺序为 balance / updatedAt / open / anchor。 */
const OPEN = { state1: Date.now(), state2: true, state3: { right: 10, bottom: 20 } }

let tree = render({})
assert.ok(tree !== null)
const chip = tree.children[0]
assert.equal(chip.type, 'button')
assert.equal(chip.props.className, 'dsu-chip')
// chip 结构：前置分隔符 · 红绿灯 · 金额 · 分隔符 · 余额
assert.equal(chip.children[0].props.className, 'dsu-sep', '行首要用与统计条一致的分隔符续上')
const light = chip.children[1]
assert.equal(light.props.className, 'dsu-light')
assert.ok(['peak', 'off'].includes(light.props['data-window']), '红绿灯必须标明当前时段')
const strong = chip.children[2]
// flash 空闲价：166203*1/1e6 + 15240064*0.02/1e6 + 93672*4/1e6 = 0.84569...
assert.equal(strong.children[0], '≈¥0.8457', `chip 金额应为 ≈¥0.8457，实际 ${strong.children[0]}`)
const dim = chip.children[4]
assert.equal(dim.children[0], '余额 读取中…')
assert.equal(tree.children[1], null, '面板默认关闭')

// ── 激活门控：Host 未检测到官方渠道时 projection 缺席，指示器什么都不渲染 ──
faceValue = undefined
assert.equal(render({}), null, 'projection 缺席时不得渲染指示器')
faceValue = null
assert.equal(render({}), null, 'projection 为 null 时不得渲染指示器')

// ── 激活门控：本会话只有非官方渠道用量时同样不渲染（避免别家 provider 上出现 ¥0） ──
const foreignBuckets = [
  {
    provider: 'openai',
    model: 'gpt-x',
    window: 'off',
    uncachedInputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 5,
  },
]
const foreignView = {
  ...wireView,
  buckets: foreignBuckets,
  totals: { uncachedInputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 },
}
faceValue = foreignView
assert.equal(render({}), null, '只有非官方渠道用量时不得渲染')
// 混合会话（官方 + 别家）仍然显示，因为官方渠道确实在用
const mixedView = {
  ...wireView,
  buckets: [...wireView.buckets, ...foreignBuckets],
  totals: {
    uncachedInputTokens: wireView.totals.uncachedInputTokens + 10,
    cacheReadTokens: wireView.totals.cacheReadTokens,
    cacheWriteTokens: 0,
    outputTokens: wireView.totals.outputTokens + 5,
  },
}
faceValue = mixedView
assert.ok(render({}) !== null, '官方 + 别家的混合会话仍应显示')
faceValue = wireView

// ── 驱动 effect（余额拉取） ────────────────────────────────────────────────
render({ useProjection: () => wireView })
assert.ok(effects.length >= 1)
effects[0]()
/** 让 getState / getBalance 两个 await 都结算完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
return settle()
  .then(() => {
    assert.equal(balanceCalls, 1, '挂载后应查询一次余额')

    // ── 成功路径：保留异步写入的状态后打开面板 ────────────────────────────
    const openTree = render({}, OPEN, true)
    const panel = openTree.children[1]
    assert.ok(panel !== null, '面板应渲染')
    assert.equal(panel.props.className, 'dsu-panel')
    const dump = stringify(panel)
    assert.ok(dump.includes('¥0.8457'), '面板应显示会话金额')
    assert.ok(dump.includes('本次会话'), '面板应显示中文标题')
    assert.ok(dump.includes('¥45.67'), '面板应显示充值余额')
    assert.ok(dump.includes('¥2.00'), '面板应显示赠送余额')
    assert.ok(dump.includes('空闲'), '面板应给出高峰/空闲金额拆分')
    assert.ok(dump.includes('deepseek-flash'), '面板应按模型列出明细')
    // 各计费项目显示金额而不是 token 数，token 数退到悬停提示里
    assert.ok(dump.includes('未缓存输入 ¥0.1662'), `未缓存输入应显示金额 :: ${dump.slice(0, 520)}`)
    assert.ok(dump.includes('缓存读取 ¥0.3048'), '缓存读取应显示金额')
    assert.ok(dump.includes('输出 ¥0.3747'), '输出应显示金额')
    assert.ok(dump.includes('166,203 tokens'), 'token 数应保留在悬停提示里')
    const noUsageAt = dump.indexOf('本次会话尚无模型调用')
    assert.ok(noUsageAt === -1, '有用量时不应显示空态文案')

    // ── 失败路径：Remote 返回 ok:false 时，面板必须显示错误原文 ────────────
    balanceFailure = { code: 'NETWORK', message: 'platform unreachable' }
    render({})
    effects[0]()
    return settle().then(() => {
      const failedTree = render({}, OPEN, true)
      const failedDump = stringify(failedTree)
      assert.ok(failedDump.includes('余额查询失败'), '失败时 chip 文案应为「余额查询失败」')
      assert.ok(failedDump.includes('账号已登录'), '失败时应说明账号登录状态')
      assert.ok(failedDump.includes('NETWORK: platform unreachable'), '面板必须显示 Remote 错误原文')

      // ── 组件容错：缺失 ctx 时不得抛错 ───────────────────────────────────
      const bare = registered({ sessionId: 'session-x' })
      assert.ok(bare !== null)

      console.log('client render: 全部断言通过')
      console.log('panel 片段:', dump.slice(0, 220))
    })
  })
  .catch((error) => {
    console.error('client render 失败:', error)
    process.exitCode = 1
  })
