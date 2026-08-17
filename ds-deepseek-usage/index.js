// ds-deepseek-usage — static Host half (v2.0: CLI 登录, token 从文件读取).
// DeepSeek account usage monitor: balance + token usage sync engine,
// real-time local agent token counting, and file-based persistence.
// 登录方式:运行 ds-wechat-login --token-file <DSH_HOME>/ds-deepseek-usage.token
// 获取 userToken,本插件定时从该文件读取(无需重启,10s 内自动生效)。
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'ds-usage-host'
export const inject = ['webServer', 'timer']

const BASE = 'https://platform.deepseek.com'
const SYNC_INTERVAL_MS = 3600000
const AUTH_CODES = [40002, 40003]
const TOKEN_RELOAD_MS = 10000
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
// 调试/热重载验证:每次模块加载生成,state.buildStamp 变化即证明代码已重载(HMR 生效)
const BUILD_STAMP = Date.now()

function dshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}
/** token 文件路径;可用环境变量 DS_USAGE_TOKEN_FILE 覆盖 */
function tokenFilePath() {
  return process.env.DS_USAGE_TOKEN_FILE?.trim() || join(dshHome(), 'ds-deepseek-usage.token')
}
function stateFilePath() {
  return join(dshHome(), 'ds-deepseek-usage.json')
}
/** 从 token 文件读取 userToken(文件不存在返回 null) */
function readTokenFile() {
  try {
    const t = readFileSync(tokenFilePath(), 'utf8').trim()
    return t || null
  } catch (e) {
    return null
  }
}

// ---- DeepSeek Platform account API (token-authenticated) ----
async function platformGet(token, path) {
  const res = await fetch(BASE + path, {
    headers: { 'User-Agent': BROWSER_UA, Authorization: 'Bearer ' + token, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  })
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error('登录已失效'), { auth: true })
  let data = null
  try { data = await res.json() } catch (e) { throw new Error('接口返回无法解析') }
  const code = data && data.code
  if (code !== undefined && code !== 0) {
    if (AUTH_CODES.indexOf(code) >= 0) throw Object.assign(new Error('登录已失效(code ' + code + ')'), { auth: true })
    throw new Error('接口错误 code ' + code)
  }
  const biz = data && data.data
  if (biz && biz.biz_code !== undefined && biz.biz_code !== 0) {
    if (AUTH_CODES.indexOf(biz.biz_code) >= 0) throw Object.assign(new Error('登录已失效(biz ' + biz.biz_code + ')'), { auth: true })
    throw new Error('接口业务错误 ' + biz.biz_code)
  }
  return data
}

async function validateToken(t) {
  try {
    const d = await platformGet(t, '/api/v0/users/get_user_summary')
    return Boolean(d && d.data)
  } catch (e) { return false }
}

export async function apply(ctx) {
  let token = null
  let baseline = null
  let local = freshLocal()
  let dayKey = localDateKey()
  let syncing = false
  let syncError = null
  let clientVisible = false
  let tokenReloadDisposer = null
  let cliLogin = null
  let persistenceKind = 'memory'
  let persistenceError = null

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0 }
  function pad2(n) { return n < 10 ? '0' + n : String(n) }
  function localDateKey() { const t = new Date(); return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate()) }
  function localMonthKey() { const t = new Date(); return t.getFullYear() + '-' + pad2(t.getMonth() + 1) }
  function utc8DateKey() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) }
  function freshLocal() { return { dayKey: localDateKey(), monthKey: localMonthKey(), todayTokens: 0, monthTokens: 0, requests: 0, hit: 0, miss: 0, output: 0, byModel: {} } }

  function persistNow() {
    const file = stateFilePath()
    const payload = { token, baseline, local }
    try {
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, JSON.stringify(payload), 'utf8')
      persistenceKind = 'file'
      persistenceError = null
    } catch (e) {
      persistenceKind = 'memory'
      persistenceError = String(e && e.message || e)
      console.error('ds-usage: 持久化写入失败:', e)
    }
  }
  const persistSoon = ctx.debounce(persistNow, 4000)

  function restore() {
    const file = stateFilePath()
    try {
      const raw = readFileSync(file, 'utf8')
      const rec = JSON.parse(raw)
      baseline = rec.baseline || null
      if (rec.local) {
        local = rec.local
        if (!local.monthKey) local.monthKey = localMonthKey()
      }
      dayKey = local.dayKey
      persistenceKind = 'file'
      persistenceError = null
    } catch (e) {
      if (e && e.code !== 'ENOENT') console.error('ds-usage: 恢复状态失败:', e)
    }
  }

  function rollDay() {
    const k = localDateKey()
    const mk = localMonthKey()
    if (k === dayKey && (local.monthKey === mk || !local.monthKey)) {
      if (!local.monthKey) local.monthKey = mk
      return
    }
    dayKey = k
    const keepMonth = (local.monthKey === mk) ? local.monthTokens : 0
    local = freshLocal()
    local.monthTokens = keepMonth
    if (baseline) baseline.today = { tokens: 0, cost: 0, requests: 0 }
    persistSoon()
  }

  function addLocalUsage(model, u) {
    rollDay()
    const hit = num(u.cacheReadTokens) + num(u.cacheWriteTokens)
    const miss = num(u.inputTokens)
    const outT = num(u.outputTokens)
    const add = hit + miss + outT
    local.todayTokens += add
    local.monthTokens += add
    local.hit += hit
    local.miss += miss
    local.output += outT
    const m = local.byModel[model] || 0
    local.byModel[model] = m + add
    persistSoon()
  }

  // 参照官方 @deepseek-ai/dsh-agent-loop 的 invariant 监听器(cordis 语义):
  // prepend —— 排在既有监听器之前,保证本观察者先于其他转换者看到流;
  // global —— 绕过 emit 方的 context filter(当前 dsh-llm 无 filter,属加固,
  // 防止未来 emitter 加过滤后漏看);监听器仍归本 fiber 所有,卸载时自动移除。
  ctx.on('llm/stream', function (options, next) {
    const inner = next()
    let counted = false
    return (async function* () {
      for await (const chunk of inner) {
        // 本插件只是用量观察者,任何统计错误都只记录、绝不允许抛出,
        // 以免破坏主对话流(此前 localMonthKey 未定义就曾导致对话崩溃)。
        try {
          if (!counted) {
            counted = true
            rollDay()
            local.requests += 1
          }
          if (chunk && chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
            addLocalUsage(String(options && options.model || 'unknown'), chunk.usage)
          }
        } catch (e) {
          console.error('ds-usage: 本地统计失败(已忽略,不影响对话):', e)
        }
        yield chunk
      }
    })()
  }, { global: true, prepend: true })

  async function syncAccount() {
    if (!token || syncing) return false
    syncing = true
    syncError = null
    try {
      const now = new Date()
      const month = now.getUTCMonth() + 1
      const year = now.getUTCFullYear()
      const pair = await Promise.all([
        platformGet(token, '/api/v0/users/get_user_summary'),
        platformGet(token, '/api/v0/users/usage/amount?month=' + month + '&year=' + year),
        platformGet(token, '/api/v0/users/usage/cost?month=' + month + '&year=' + year),
      ])
      baseline = parseSnapshot(pair[0], pair[1], pair[2])
      persistSoon()
      return true
    } catch (e) {
      syncError = String(e && e.message || e)
      console.error('ds-usage: 同步失败:', e)
      return false
    } finally {
      syncing = false
    }
  }

  async function maybeSync() {
    if (!clientVisible || !token || syncing) return false
    if (baseline === null || Date.now() - baseline.syncedAt > SYNC_INTERVAL_MS) return syncAccount()
    return false
  }

  // ---- token 文件重载(CLI 登录后自动生效) ----
  async function reloadTokenFromFile() {
    const t = readTokenFile()
    if (t === token) return
    token = t
    persistNow()
    if (token) {
      const ok = await validateToken(token)
      if (!ok) { invalidateToken(); return }
    }
    baseline = null
    syncAccount()
  }

  // 定时检查 token 文件(mtime/内容变化即重载;文件被删=登出)
  function startTokenWatcher() {
    if (tokenReloadDisposer) return
    tokenReloadDisposer = ctx.interval(function () {
      reloadTokenFromFile().catch(function (e) {
        console.error('ds-usage: token 重载失败:', e)
      })
    }, TOKEN_RELOAD_MS)
  }

  // ---- CLI 登录(调用包内自带的 login-cli.mjs,二维码由 CLI 生成并回传 dataURL) ----
  // 该 CLI 随插件包一起分发(不作为独立 npm 工具);可用 DS_WECHAT_LOGIN_BIN 覆盖。
  const BUNDLED_CLI = join(dirname(fileURLToPath(import.meta.url)), 'login-cli.mjs')
  function resolveCliLogin() {
    return process.env.DS_WECHAT_LOGIN_BIN?.trim() || BUNDLED_CLI
  }

  function cliLoginState() {
    if (!cliLogin) return null
    return { status: cliLogin.status, qr: cliLogin.qr || null, error: cliLogin.error || null }
  }

  function cliLoginStart() {
    cliLoginCancel()
    cliLogin = { status: 'starting', qr: null, error: null, proc: null }
    let proc
    try {
      proc = spawn(resolveCliLogin(), ['--json-lines', '--token-file', tokenFilePath()], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      cliLogin = { status: 'error', qr: null, error: '无法启动 ds-wechat-login: ' + (e && e.message || e), proc: null }
      return cliLoginState()
    }
    cliLogin.proc = proc
    let buf = ''
    proc.stdout.on('data', function (d) {
      buf += d.toString()
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        try {
          const m = JSON.parse(line)
          if (m.status === 'waiting') { cliLogin.status = 'waiting'; cliLogin.qr = m.qr || null }
          else if (m.status === 'scanned') { cliLogin.status = 'scanned' }
          else if (m.status === 'done') { cliLogin.status = 'done'; if (m.token) { token = m.token; persistNow(); syncAccount() } }
          else if (m.status === 'error') { cliLogin.status = 'error'; cliLogin.error = m.error || '登录失败' }
        } catch (e) { /* 忽略非 JSON 行 */ }
      }
    })
    proc.stderr.on('data', function () { /* ignore */ })
    proc.on('error', function (e) {
      if (cliLogin && cliLogin.proc === proc) {
        cliLogin.status = 'error'
        cliLogin.error = 'CLI 启动失败: ' + (e && e.message || e) + '(请先 npm i -g ds-wechat-login)'
        cliLogin.proc = null
      }
    })
    proc.on('exit', function (code) {
      if (cliLogin && cliLogin.proc === proc) {
        if (cliLogin.status !== 'done' && cliLogin.status !== 'error') {
          cliLogin.status = 'error'
          cliLogin.error = 'CLI 异常退出(码 ' + code + ')'
        }
        cliLogin.proc = null
      }
    })
    return cliLoginState()
  }

  function cliLoginCancel() {
    if (cliLogin && cliLogin.proc) {
      try { cliLogin.proc.kill('SIGTERM') } catch (e) { /* ignore */ }
    }
    cliLogin = null
  }

  function sumUsage(items) {
    const s = { tokens: 0, hit: 0, miss: 0, output: 0, requests: 0 }
    ;(items || []).forEach(function (it) {
      const t = String(it.type || '')
      const v = num(it.amount)
      if (t === 'REQUEST') s.requests += v
      else if (t === 'PROMPT_CACHE_HIT_TOKEN') { s.hit += v; s.tokens += v }
      else if (t === 'PROMPT_CACHE_MISS_TOKEN') { s.miss += v; s.tokens += v }
      else if (t === 'RESPONSE_TOKEN') { s.output += v; s.tokens += v }
    })
    return s
  }
  function sumCost(items) {
    let s = 0
    ;(items || []).forEach(function (it) {
      if (String(it.type || '') !== 'REQUEST') s += num(it.amount)
    })
    return s
  }

  function parseSnapshot(sum, amt, cost) {
    const w = sum && sum.data && sum.data.biz_data
    const norm = (w && w.normal_wallets) || []
    const bonus = (w && w.bonus_wallets) || []
    const byCur = {}
    norm.forEach(function (x) {
      const c = String(x.currency || 'CNY')
      const e = byCur[c] || (byCur[c] = { currency: c, toppedUp: 0, granted: 0 })
      e.toppedUp += num(x.balance)
    })
    bonus.forEach(function (x) {
      const c = String(x.currency || 'CNY')
      const e = byCur[c] || (byCur[c] = { currency: c, toppedUp: 0, granted: 0 })
      e.granted += num(x.balance)
    })
    const curs = Object.keys(byCur)
    let bal = { currency: 'CNY', total: 0, toppedUp: 0, granted: 0 }
    if (curs.length > 0) {
      const funded = curs.filter(function (c) { return byCur[c].toppedUp + byCur[c].granted > 0 })
      const pick = funded.indexOf('USD') >= 0 ? 'USD' : (funded[0] || (curs.indexOf('USD') >= 0 ? 'USD' : curs[0]))
      const e = byCur[pick]
      bal = { currency: pick, total: e.toppedUp + e.granted, toppedUp: e.toppedUp, granted: e.granted }
    }
    // Cumulative spend (get_user_summary total_costs) — recharge total ≈ balance + cumulative cost.
    const tCosts = (w && w.total_costs) || []
    let totalCost = 0
    tCosts.forEach(function (x) {
      if (String(x.currency || '') === bal.currency) totalCost += num(x.amount)
    })
    const aBiz = (amt && amt.data && amt.data.biz_data) || {}
    const aTotal = aBiz.total || []
    const aDays = aBiz.days || []
    const cBiz = cost && cost.data && cost.data.biz_data
    const cList = Array.isArray(cBiz) ? cBiz : []
    const cTotal = (cList[0] && cList[0].total) || []
    const cDays = (cList[0] && cList[0].days) || []
    const currency = (cList[0] && cList[0].currency) || bal.currency
    const byModel = {}
    aTotal.forEach(function (m) {
      const model = String((m && m.model) || 'unknown')
      const e = byModel[model] || (byModel[model] = { model: model, tokens: 0, hit: 0, miss: 0, output: 0, requests: 0, cost: 0 })
      const s = sumUsage(m && m.usage)
      e.tokens += s.tokens; e.hit += s.hit; e.miss += s.miss; e.output += s.output; e.requests += s.requests
    })
    cTotal.forEach(function (m) {
      const model = String((m && m.model) || 'unknown')
      const e = byModel[model] || (byModel[model] = { model: model, tokens: 0, hit: 0, miss: 0, output: 0, requests: 0, cost: 0 })
      e.cost += sumCost(m && m.usage)
    })
    const cats = { hit: 0, miss: 0, output: 0 }
    Object.keys(byModel).forEach(function (k) {
      cats.hit += byModel[k].hit; cats.miss += byModel[k].miss; cats.output += byModel[k].output
    })
    const dayMap = {}
    aDays.forEach(function (d) {
      const key = String(d && d.date || '')
      if (!key) return
      const e = dayMap[key] || (dayMap[key] = { tokens: 0, cost: 0, requests: 0 })
      ;(d && d.data || []).forEach(function (m) {
        const s = sumUsage(m && m.usage)
        e.tokens += s.tokens; e.requests += s.requests
      })
    })
    cDays.forEach(function (d) {
      const key = String(d && d.date || '')
      if (!key) return
      const e = dayMap[key] || (dayMap[key] = { tokens: 0, cost: 0, requests: 0 })
      ;(d && d.data || []).forEach(function (m) { e.cost += sumCost(m && m.usage) })
    })
    const dates = Object.keys(dayMap).sort()
    const lk = localDateKey()
    const ck = utc8DateKey()
    let todayKey = null
    if (dates.indexOf(lk) >= 0) todayKey = lk
    else if (dates.indexOf(ck) >= 0) todayKey = ck
    else if (dates.length > 0) todayKey = dates[dates.length - 1]
    const today = (todayKey && dayMap[todayKey]) || { tokens: 0, cost: 0, requests: 0 }
    let mTokens = 0, mCost = 0, mRequests = 0
    dates.forEach(function (k) {
      mTokens += dayMap[k].tokens; mCost += dayMap[k].cost; mRequests += dayMap[k].requests
    })
    const models = Object.keys(byModel).map(function (k) { return byModel[k] }).sort(function (a, b) { return b.tokens - a.tokens })
    return {
      syncedAt: Date.now(),
      currency: currency,
      balance: { currency: bal.currency, total: bal.total, toppedUp: bal.toppedUp, granted: bal.granted, available: bal.total > 0 },
      totalCost: totalCost,
      today: today,
      month: { tokens: mTokens, cost: mCost, requests: mRequests },
      categories: cats,
      models: models,
    }
  }

  function buildState() {
    rollDay()
    const b = baseline
    // 平台同步的账户总量为权威值;本地实时计数仅在平台尚未反映时补位
    // (取两者较大者,避免把已同步进 baseline 的用量再叠加一次)。
    const todayTokens = Math.max(b && b.today ? b.today.tokens : 0, local.todayTokens)
    const monthTokens = Math.max(b && b.month ? b.month.tokens : 0, local.monthTokens)
    const hit = local.hit
    const miss = local.miss
    const output = local.output
    const requests = local.requests
    const modelMap = {}
    Object.keys(local.byModel).forEach(function (k) {
      modelMap[k] = { model: k, tokens: local.byModel[k], cost: 0 }
    })
    const models = Object.keys(modelMap).map(function (k) { return modelMap[k] }).sort(function (a, b) { return b.tokens - a.tokens })
    const staleMs = b ? Math.max(0, Date.now() - b.syncedAt) : 0
    return {
      loggedIn: Boolean(token),
      tokenFile: tokenFilePath(),
      buildStamp: BUILD_STAMP,
      login: cliLoginState(),
      persistence: persistenceKind,
      persistenceError: persistenceError,
      syncing: syncing,
      syncError: syncError,
      lastSyncAt: b ? b.syncedAt : null,
      nextSyncIn: b ? Math.max(0, SYNC_INTERVAL_MS - staleMs) : 0,
      balance: b ? b.balance : null,
      totalCost: b ? (b.totalCost || 0) : 0,
      currency: b ? b.currency : 'CNY',
      today: { tokens: todayTokens, cost: 0 },
      month: { tokens: monthTokens, cost: b ? b.month.cost : 0, requests: requests },
      categories: { hit: hit, miss: miss, output: output },
      models: models,
      localDelta: { today: local.todayTokens, month: local.monthTokens },
    }
  }

  // ---- HTTP API (Client <-> Host) ----
  function isSameOrigin(req) {
    const host = String(req.headers.host || '')
    const origin = String(req.headers.origin || '')
    if (origin === '') return true
    try { return new URL(origin).host === host } catch (e) { return false }
  }
  function sendJson(res, status, value) {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  }
  async function readBody(req, limit) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) throw new Error('payload too large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  async function apiHandler(req, res) {
    try {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'allow': 'POST', 'content-length': '0' })
        res.end()
        return
      }
      if (!isSameOrigin(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      const body = await readBody(req, 65536)
      let payload = {}
      try { payload = JSON.parse(body) } catch (e) { /* empty */ }
      const method = payload.method || 'state'
      switch (method) {
        case 'state':
          sendJson(res, 200, buildState())
          return
        case 'tick':
          clientVisible = true
          await reloadTokenFromFile()
          await maybeSync()
          sendJson(res, 200, buildState())
          return
        case 'hidden':
          clientVisible = false
          sendJson(res, 200, buildState())
          return
        case 'syncNow':
          await syncAccount()
          sendJson(res, 200, buildState())
          return
        case 'reloadToken':
          // CLI 登录后手动触发重读 token 文件
          await reloadTokenFromFile()
          sendJson(res, 200, buildState())
          return
        case 'cliLoginStart':
          sendJson(res, 200, cliLoginStart())
          return
        case 'cliLoginStatus':
          sendJson(res, 200, cliLoginState())
          return
        case 'cliLoginCancel':
          cliLoginCancel()
          sendJson(res, 200, { status: 'idle' })
          return
        case 'logout':
          cliLoginCancel()
          invalidateToken()
          try { if (existsSync(tokenFilePath())) unlinkSync(tokenFilePath()) } catch (e) { /* ignore */ }
          persistNow()
          sendJson(res, 200, buildState())
          return
        default:
          sendJson(res, 400, { error: 'unknown method: ' + method })
      }
    } catch (e) {
      sendJson(res, 500, { error: String(e && e.message || e) })
    }
  }

  function invalidateToken() {
    token = null
    baseline = null
    persistSoon()
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/ds-usage',
    handler: apiHandler,
  }), 'ds-usage: api route')

  ctx.effect(function () {
    return function () {
      if (tokenReloadDisposer) { tokenReloadDisposer(); tokenReloadDisposer = null }
      cliLoginCancel()
    }
  })

  restore()
  startTokenWatcher()
  // 启动时读取一次 token 文件
  reloadTokenFromFile().then(function () {
    if (token && baseline && typeof baseline.totalCost !== 'number') {
      // Stale persisted baseline from before totalCost existed — refresh now.
      syncAccount()
    }
  }).catch(function (e) {
    console.error('ds-usage: 初始 token 读取失败:', e)
  })
}
