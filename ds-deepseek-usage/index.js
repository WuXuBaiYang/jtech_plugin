// ds-deepseek-usage — static Host half (v2: API-based QR login).
// DeepSeek account usage monitor: balance + token usage sync engine,
// WeChat scan-to-login via platform auth APIs (no browser/CDP), and
// file-based persistence.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { solveDeepSeekPow } from './ds-pow.js'

export const name = 'ds-usage-host'
export const inject = ['webServer', 'timer']

const BASE = 'https://platform.deepseek.com'
const AUTH_BASE = BASE + '/auth-api/v0/users'
const SYNC_INTERVAL_MS = 3600000
const AUTH_CODES = [40002, 40003]
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const WX_APPID = 'wx335255e1b73f9e52'
const WX_CALLBACK = BASE + '/auth-api/v0/users/oauth/wechat/callback'
const WX_QR_BASE = 'https://open.weixin.qq.com/connect/qrconnect'
const WX_POLL_BASE = 'https://long.open.weixin.qq.com/connect/l/qrconnect'

// ---- HTTP helpers (global fetch; Node >= 22) ----
async function dsFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'Origin': BASE,
      'Referer': BASE + '/sign_in',
      ...(options.headers || {}),
    },
    redirect: options.redirect === undefined ? 'follow' : options.redirect,
    signal: options.signal || AbortSignal.timeout(20000),
  })
}

async function postJson(url, body, headers = {}) {
  const res = await dsFetch(url, { method: 'POST', body: JSON.stringify(body), headers })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch (e) { json = null }
  return { status: res.status, json, text }
}

// ---- Proof-of-work gate for protected auth endpoints ----
async function solveForTarget(targetPath) {
  const { json } = await postJson(AUTH_BASE + '/create_guest_challenge', { target_path: targetPath })
  const gc = json && json.data && json.data.biz_data && json.data.biz_data.guest_challenge
  if (!gc) throw new Error('获取挑战失败: ' + JSON.stringify(json).slice(0, 160))
  const answer = solveDeepSeekPow(gc.challenge, gc.salt, gc.expire_at, gc.difficulty)
  if (answer === null) throw new Error('PoW 挑战无解')
  return Buffer.from(JSON.stringify({ salt: gc.salt, answer })).toString('base64')
}

/** POST to a PoW-protected auth endpoint (login/send-code etc.). */
async function authPost(path, body) {
  // 挑战接口的 target_path 必须是去掉域名的路径形式
  // (如 /auth-api/v0/users/login_by_mobile_sms;完整 URL 或纯相对路径都会
  // 返回 INVALID_TARGET_PATH)
  const targetPath = AUTH_BASE.replace(BASE, '') + path
  const proof = await solveForTarget(targetPath)
  return postJson(AUTH_BASE + path, body, { 'X-DS-Guest-PoW-Response': proof })
}

// ---- DeepSeek Platform account API (token-authenticated) ----
async function platformGet(token, path) {
  const res = await dsFetch(BASE + path, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
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

// ---- WeChat QR login ----
function wxQrUrl() {
  return WX_QR_BASE + '?appid=' + WX_APPID +
    '&scope=snsapi_login&redirect_uri=' + encodeURIComponent(WX_CALLBACK) +
    '&state=&login_type=jssdk&self_redirect=false&stylelite=1&fast_login=0'
}

/** Step 1: fetch a fresh WeChat QR uuid (f=xml) and build the session. */
async function qrCreate() {
  const res = await dsFetch(wxQrUrl() + '&f=xml&' + Date.now(), {
    headers: { Accept: 'text/xml, application/xml, */*' },
  })
  const xml = await res.text()
  const m = xml.match(/<uuid><!\[CDATA\[([^\]]+)\]\]><\/uuid>/) || xml.match(/<uuid>([^<]+)<\/uuid>/)
  if (!m) throw new Error('微信二维码创建失败: ' + xml.slice(0, 120))
  const uuid = m[1]
  return {
    uuid,
    phase: 'waiting',               // waiting -> scanned -> confirmed -> done | expired | error
    startedAt: Date.now(),
    qrImageUrl: 'https://open.weixin.qq.com/connect/qrcode/' + uuid,
    error: null,
  }
}

/** Step 2: poll WeChat login status; on confirm, exchange code -> token. */
async function qrPoll(session, setToken, syncNow) {
  const res = await dsFetch(WX_POLL_BASE + '?uuid=' + encodeURIComponent(session.uuid) + '&_=' + Date.now(), {
    headers: { Accept: 'text/javascript, */*' },
  })
  const body = await res.text()
  const err = (body.match(/wx_errcode\s*=\s*(\d+)/) || [])[1]
  const code = (body.match(/wx_code\s*=\s*'([^']*)'/) || [])[1] || ''
  if (code) {
    // WeChat confirmed the scan — exchange the code for a platform token.
    const token = await exchangeWechatCode(code)
    setToken(token)
    session.phase = 'done'
    session.error = null
    syncNow()
    return session
  }
  if (err === '402') { session.phase = 'expired'; session.error = '二维码已过期，请刷新重试'; return session }
  if (err === '405') { session.phase = 'scanned'; return session }
  // 408 or anything else: still waiting
  session.phase = 'waiting'
  return session
}

/** Exchange the WeChat auth code for a DeepSeek userToken. */
async function exchangeWechatCode(code) {
  // 1. platform callback swaps code -> nonce (307 redirect to /sign_in?nonce=...&provider=WECHAT)
  const cb = await dsFetch(WX_CALLBACK + '?code=' + encodeURIComponent(code) + '&state=', {
    redirect: 'manual',
    headers: { Accept: 'text/html,application/xhtml+xml' },
  })
  let nonce = null
  const loc = cb.headers.get('location')
  const locMatch = loc && loc.match(/\bnonce=([^&]+)/)
  if (locMatch) nonce = locMatch[1]
  if (!nonce) {
    // Fallback: follow the redirect and read the final URL.
    const fin = await dsFetch(WX_CALLBACK + '?code=' + encodeURIComponent(code) + '&state=', {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    })
    const finMatch = fin.url.match(/\bnonce=([^&]+)/)
    if (finMatch) nonce = finMatch[1]
  }
  if (!nonce) throw new Error('微信回调未返回 nonce')
  // 2. exchange nonce -> userToken (no PoW gate)
  const { json } = await postJson(AUTH_BASE + '/oauth/get_token', { nonce, provider: 'WECHAT' })
  const token = json && json.data && json.data.biz_data && json.data.biz_data.token
  if (!token) throw new Error('获取 token 失败: ' + JSON.stringify(json).slice(0, 160))
  return token
}

// ---- SMS login ----
let smsDeviceId = null
function deviceId() {
  if (!smsDeviceId) smsDeviceId = randomUUID()
  return smsDeviceId
}

/**
 * 发送短信验证码。接口经实机验证:需要 scenario="login" 与一种人机验证
 * (turnstile/shumei/hcaptcha),但**不需要** PoW(缺验证码返回 RECAPTCHA_VERIFY_FAILED,
 * 而非 Missing Header)。验证码由 client 半区在 DSH 浏览器里渲染 Turnstile 获得。
 */
async function smsSendCode(mobile, areaCode, turnstileToken) {
  const body = {
    locale: 'zh_CN',
    device_id: deviceId(),
    scenario: 'login',
    mobile_number: mobile,
    area_code: areaCode,
  }
  if (turnstileToken) body.turnstile_token = turnstileToken
  const { json } = await postJson(AUTH_BASE + '/create_sms_verification_code', body)
  const biz = json && json.data
  const code = biz && biz.biz_code
  if (code === 0) {
    return { ok: true, sendWindowSecs: (biz.biz_data && biz.biz_data.send_window_secs) || 60 }
  }
  const msg = biz && biz.biz_msg
  if (code === 2) throw new Error('人机验证未通过(验证码类型可能不匹配),请刷新重试')
  throw new Error('发送失败: ' + (msg || JSON.stringify(json).slice(0, 120)))
}

/**
 * 短信验证码登录。需 PoW 证明头(实机验证:带证明后进入真实校验,
 * 假码返回 SMS_EXPIRED/SMS_VERIFY_FAILED)。成功后从响应提取 token。
 */
async function smsLogin(mobile, areaCode, code) {
  const body = {
    region: 'CN',
    locale: 'zh_CN',
    mobile_number: mobile,
    area_code: areaCode,
    sms_verification_code: code,
    device_id: deviceId(),
    os: 'web',
  }
  const { json } = await authPost('/login_by_mobile_sms', body)
  const biz = json && json.data
  const bizCode = biz && biz.biz_code
  if (bizCode !== 0) {
    const msg = biz && biz.biz_msg
    throw new Error(msg === 'SMS_EXPIRED' ? '验证码已过期,请重新获取' : (msg === 'SMS_VERIFY_FAILED' ? '验证码错误' : '登录失败: ' + (msg || bizCode)))
  }
  const bd = biz.biz_data || {}
  // 尝试从响应提取 userToken(oauth 的 get_token 同样返回 biz_data.token)
  const token = bd.token || bd.userToken || bd.access_token || bd.session_token
  if (!token) throw new Error('登录成功但响应未包含 token,请改用微信扫码登录')
  return token
}

function stateFilePath() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'ds-deepseek-usage.json')
}

export async function apply(ctx) {
  let token = null
  let baseline = null
  let local = freshLocal()
  let dayKey = localDateKey()
  let syncing = false
  let syncError = null
  let clientVisible = false
  let qr = null
  let qrDisposer = null
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
      token = rec.token || null
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

  // ---- QR login lifecycle ----
  async function qrStart() {
    stopQrPoll()
    try {
      qr = await qrCreate()
      qrDisposer = ctx.interval(function () {
        qrPollTick().catch(function (e) {
          console.error('ds-usage: 扫码轮询失败:', e)
          if (qr) { qr.error = String(e && e.message || e); qr.phase = 'error' }
        })
      }, 2000)
      return qrState()
    } catch (e) {
      qr = { phase: 'error', error: String(e && e.message || e), startedAt: Date.now(), qrImageUrl: null }
      return qrState()
    }
  }

  async function qrPollTick() {
    if (!qr || qr.phase === 'done' || qr.phase === 'expired' || qr.phase === 'error') return
    if (Date.now() - qr.startedAt > 600000) { qr.phase = 'expired'; qr.error = '登录超时，请重试'; stopQrPoll(); return }
    await qrPoll(qr, function (t) { token = t; persistNow() }, function () { syncAccount() })
    if (qr.phase === 'done') stopQrPoll()
  }

  function stopQrPoll() {
    if (qrDisposer) { qrDisposer(); qrDisposer = null }
  }

  function qrState() {
    if (!qr) return null
    return { phase: qr.phase, qrImageUrl: qr.qrImageUrl, error: qr.error }
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
      persistence: persistenceKind,
      persistenceError: persistenceError,
      syncing: syncing,
      syncError: syncError,
      lastSyncAt: b ? b.syncedAt : null,
      nextSyncIn: b ? Math.max(0, SYNC_INTERVAL_MS - staleMs) : 0,
      login: qrState(),
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
        case 'loginStart':
          sendJson(res, 200, await qrStart())
          return
        case 'loginPoll':
          await qrPollTick()
          sendJson(res, 200, qrState())
          return
        case 'loginCancel':
          stopQrPoll()
          qr = null
          sendJson(res, 200, { phase: 'idle' })
          return
        case 'smsSendCode':
          // {mobile, areaCode, turnstileToken}
          await smsSendCode(String(payload.mobile || ''), String(payload.areaCode || '+86'), payload.turnstileToken)
          sendJson(res, 200, { ok: true })
          return
        case 'smsLogin':
          // {mobile, areaCode, code}
          token = await smsLogin(String(payload.mobile || ''), String(payload.areaCode || '+86'), String(payload.code || ''))
          persistNow()
          syncAccount()
          sendJson(res, 200, buildState())
          return
        case 'logout':
          stopQrPoll()
          qr = null
          invalidateToken()
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
      stopQrPoll()
    }
  })

  restore()
  if (token) {
    validateToken(token).then(function (ok) {
      if (!ok) {
        invalidateToken()
      } else if (baseline && typeof baseline.totalCost !== 'number') {
        // Stale persisted baseline from before totalCost existed — refresh now.
        syncAccount()
      }
    })
  }
}
