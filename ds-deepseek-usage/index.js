// ds-deepseek-usage — static Host half.
// DeepSeek account usage monitor: balance + token usage sync engine,
// browser-login (CDP) auth capture, real-time local agent token counting,
// and file-based persistence (plain node:fs — no storage-domain dependency).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'ds-usage-host'
export const inject = ['webServer', 'timer']

const BASE = 'https://platform.deepseek.com'
const SYNC_INTERVAL_MS = 3600000
const AUTH_CODES = [40002, 40003]

// localStorage userToken (JSON {value} or bare string), then cookie fallback.
const TOKEN_PROBE = "(function(){try{var v=localStorage.getItem('userToken');if(v)return v;var m=document.cookie.match(/(?:^|;\\s*)userToken=([^;]+)/);return m?decodeURIComponent(m[1]):''}catch(e){return ''}})()"

const HELPER = [
  "const cmd=process.argv[1],a=process.argv[2],b=process.argv[3];",
  "const out=o=>{console.log(JSON.stringify(o));process.exit(0)};",
  "const fail=e=>{console.log(JSON.stringify({error:String(e&&e.message||e)}));process.exit(1)};",
  "(async()=>{try{",
  "if(cmd==='fetch'){const h=b?JSON.parse(b):{};const r=await fetch(a,{headers:h,signal:AbortSignal.timeout(20000)});const t=await r.text();out({status:r.status,body:t.slice(0,400000)});}",
  "else if(cmd==='cdp'){const r=await fetch('http://127.0.0.1:'+a+b,{signal:AbortSignal.timeout(5000)});out({status:r.status,body:await r.text()});}",
  "else if(cmd==='eval'){const ws=new WebSocket(a);const p=new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('cdp-eval-timeout')),8000);ws.onopen=()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:b,returnByValue:true}}));ws.onerror=()=>rej(new Error('ws-error'));ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id===1){clearTimeout(t);res(m)}};});const m=await p;try{ws.close()}catch(e){}out({result:m.result});}",
  "else if(cmd==='cookies'){const ws=new WebSocket(a);const p=new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('cdp-cookies-timeout')),8000);ws.onopen=()=>ws.send(JSON.stringify({id:1,method:'Network.getCookies',params:{}}));ws.onerror=()=>rej(new Error('ws-error'));ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id===1){clearTimeout(t);res(m)}};});const m=await p;try{ws.close()}catch(e){}out({result:m.result});}",
  "else if(cmd==='discover'){const fs=require('node:fs'),os=require('node:os');const pf=process.env['PROGRAMFILES(X86)']||'C:/Program Files (x86)',pf64=process.env['PROGRAMW6432']||process.env['PROGRAMFILES']||'C:/Program Files',la=process.env['LOCALAPPDATA'];const cs=[];if(pf)cs.push(pf+'/Microsoft/Edge/Application/msedge.exe');if(pf64)cs.push(pf64+'/Microsoft/Edge/Application/msedge.exe');if(la)cs.push(la+'/Microsoft/Edge/Application/msedge.exe');if(pf)cs.push(pf+'/Google/Chrome/Application/chrome.exe');if(pf64)cs.push(pf64+'/Google/Chrome/Application/chrome.exe');if(la)cs.push(la+'/Google/Chrome/Application/chrome.exe');let edge=null,chrome=null;for(const p of cs){if(!fs.existsSync(p))continue;if(!edge&&p.indexOf('Edge')>=0)edge=p;if(!chrome&&p.indexOf('Chrome')>=0)chrome=p;}out({edge:edge,chrome:chrome,home:os.homedir()});}",
  "else fail(new Error('unknown-command'));",
  "}catch(e){fail(e)}})();"
].join('')

function stateFilePath() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'ds-deepseek-usage.json')
}

export async function apply(ctx) {
  const subprocess = ctx.get('subprocess')

  let token = null
  let baseline = null
  let local = freshLocal()
  let dayKey = localDateKey()
  let syncing = false
  let syncError = null
  let clientVisible = false
  let login = null
  let edgeHandle = null
  let loginDisposer = null
  let nodePath = null
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

  async function resolveNode() {
    if (subprocess === undefined) return null
    try { return await subprocess.resolveExecutable('node') } catch (e) { /* next */ }
    try {
      const cmdPath = await subprocess.resolveExecutable('cmd')
      const h = subprocess.spawn({
        argv: [cmdPath, '/c', 'where', 'node'],
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
        graceMs: 5000,
      })
      await h.done
      const text = h.collected.stdout ? h.collected.stdout.finalize().text : ''
      const line = String(text).split('\n').map(function (s) { return s.trim() }).filter(function (s) { return s.length > 0 })[0]
      if (line) return line
    } catch (e) { /* next */ }
    return null
  }

  async function nodeRun(args) {
    if (subprocess === undefined) throw new Error('subprocess 服务不可用')
    if (nodePath === null) nodePath = await resolveNode()
    if (!nodePath) throw new Error('找不到 node 运行时')
    const handle = subprocess.spawn({
      argv: [nodePath, '-e', HELPER].concat(args),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1048576 }, stderr: { maxBytes: 65536 } },
      graceMs: 5000,
    })
    const done = await handle.done
    const stdoutText = handle.collected.stdout ? handle.collected.stdout.finalize().text : ''
    const stderrText = handle.collected.stderr ? handle.collected.stderr.finalize().text : ''
    let json = null
    try { json = JSON.parse(String(stdoutText).trim()) } catch (e) { json = null }
    if (done.exitCode === 0 && json !== null) return json
    throw new Error((json && json.error) ? json.error : (stderrText || ('node 退出码 ' + done.exitCode)))
  }

  async function platformGet(path) {
    const r = await nodeRun(['fetch', BASE + path, JSON.stringify({ Authorization: 'Bearer ' + token, Accept: 'application/json' })])
    if (r.status === 401 || r.status === 403) { invalidateToken(); throw new Error('登录已失效') }
    let data = null
    try { data = JSON.parse(r.body) } catch (e) { throw new Error('接口返回无法解析') }
    const code = data && data.code
    if (code !== undefined && code !== 0) {
      if (AUTH_CODES.indexOf(code) >= 0) { invalidateToken(); throw new Error('登录已失效(code ' + code + ')') }
      throw new Error('接口错误 code ' + code)
    }
    const biz = data && data.data
    if (biz && biz.biz_code !== undefined && biz.biz_code !== 0) {
      if (AUTH_CODES.indexOf(biz.biz_code) >= 0) { invalidateToken(); throw new Error('登录已失效(biz ' + biz.biz_code + ')') }
      throw new Error('接口业务错误 ' + biz.biz_code)
    }
    return data
  }

  async function validateToken(t) {
    try {
      const r = await nodeRun(['fetch', BASE + '/api/v0/users/get_user_summary', JSON.stringify({ Authorization: 'Bearer ' + t, Accept: 'application/json' })])
      if (r.status !== 200) return false
      let d = null
      try { d = JSON.parse(r.body) } catch (e) { return false }
      const code = d && d.code
      if (code !== undefined && code !== 0) return false
      const biz = d && d.data
      if (biz && biz.biz_code !== undefined && biz.biz_code !== 0) return false
      return true
    } catch (e) { return false }
  }

  function invalidateToken() {
    token = null
    baseline = null
    persistSoon()
  }

  async function syncAccount() {
    if (!token || syncing) return false
    syncing = true
    syncError = null
    try {
      const now = new Date()
      const month = now.getUTCMonth() + 1
      const year = now.getUTCFullYear()
      const pair = await Promise.all([
        platformGet('/api/v0/users/get_user_summary'),
        platformGet('/api/v0/usage/amount?month=' + month + '&year=' + year),
        platformGet('/api/v0/usage/cost?month=' + month + '&year=' + year),
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

  async function pickPort() {
    for (let i = 0; i < 6; i++) {
      const p = 9300 + Math.floor(Math.random() * 400)
      try { await nodeRun(['cdp', String(p), '/json/version']) } catch (e) { return p }
    }
    return 9300 + Math.floor(Math.random() * 400)
  }

  async function startLogin() {
    if (login && login.active) return
    if (subprocess === undefined) {
      login = { active: false, phase: 'error', error: '子进程服务不可用，无法打开浏览器' }
      return
    }
    login = { active: true, phase: 'starting', error: null }
    try {
      const disc = await nodeRun(['discover'])
      const browser = (disc && (disc.edge || disc.chrome)) || null
      if (!browser) { login = { active: false, phase: 'error', error: '未找到 Edge/Chrome 浏览器' }; return }
      const port = await pickPort()
      const home = (disc && disc.home) || ''
      const profileDir = home + '/.dsh/ds-usage-edge-profile'
      edgeHandle = subprocess.spawn({
        argv: [browser, '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--user-data-dir=' + profileDir, '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', '--disable-features=msEdgeFirstRunExperience', '--window-position=140,80', '--window-size=1024,700', BASE + '/sign_in'],
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
        graceMs: 3000,
      })
      login = { active: true, phase: 'waiting', error: null, startedAt: Date.now(), port: port }
      edgeHandle.done.then(function () {
        if (login && login.active) login = { active: false, phase: 'error', error: '浏览器已关闭，登录未完成' }
        edgeHandle = null
        stopLoginPoll()
      }).catch(function () {
        if (login && login.active) login = { active: false, phase: 'error', error: '浏览器启动失败' }
      })
      startLoginPoll()
    } catch (e) {
      login = { active: false, phase: 'error', error: String(e && e.message || e) }
      console.error('ds-usage: 登录启动失败:', e)
    }
  }

  function startLoginPoll() {
    if (loginDisposer) return
    loginDisposer = ctx.interval(async function () {
      if (!login || !login.active) return
      if (Date.now() - login.startedAt > 600000) { finishLogin('登录超时，请重试'); return }
      try {
        const lr = await nodeRun(['cdp', String(login.port), '/json/list'])
        let list = []
        try { list = JSON.parse(lr.body) } catch (e) { list = [] }
        const page = (list || []).find(function (t) {
          return t && t.type === 'page' && String(t.url || '').indexOf('platform.deepseek.com') >= 0
        })
        if (!page || !page.webSocketDebuggerUrl) return
        const ev = await nodeRun(['eval', page.webSocketDebuggerUrl, TOKEN_PROBE])
        let raw = ev && ev.result && ev.result.result && ev.result.result.value
        if (!raw) {
          try {
            const ck = await nodeRun(['cookies', page.webSocketDebuggerUrl])
            const cookies = ck && ck.result && ck.result.result && ck.result.result.cookies
            if (Array.isArray(cookies)) {
              const hit = cookies.find(function (c) { return c && /user.?token/i.test(String(c.name)) })
                || cookies.find(function (c) { return c && /token/i.test(String(c.name)) })
              if (hit && hit.value) raw = hit.value
            }
          } catch (e) { /* ignore */ }
        }
        let tok = raw
        try {
          const parsed = JSON.parse(raw)
          if (parsed && parsed.value) tok = parsed.value
        } catch (e) { /* keep raw */ }
        if (typeof tok !== 'string' || tok.length === 0) return
        login = { active: true, phase: 'validating', error: null, startedAt: login.startedAt }
        const ok = await validateToken(tok)
        if (ok) {
          token = tok
          login = { active: false, phase: 'done', error: null }
          stopLoginPoll()
          if (edgeHandle) { try { edgeHandle.terminate() } catch (e) { /* ignore */ } edgeHandle = null }
          persistNow()
          syncAccount()
        } else {
          finishLogin('登录校验失败，请重试')
        }
      } catch (e) { /* transient, keep polling */ }
    }, 2000)
  }

  function stopLoginPoll() {
    if (loginDisposer) { loginDisposer(); loginDisposer = null }
  }
  function finishLogin(msg) {
    login = { active: false, phase: 'error', error: msg }
    stopLoginPoll()
    if (edgeHandle) { try { edgeHandle.terminate() } catch (e) { /* ignore */ } edgeHandle = null }
  }
  function cancelLogin() {
    if (login && login.active) finishLogin('已取消登录')
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
      login: login ? { active: login.active, phase: login.phase, error: login.error } : null,
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
          await startLogin()
          sendJson(res, 200, buildState())
          return
        case 'loginCancel':
          cancelLogin()
          sendJson(res, 200, buildState())
          return
        case 'logout':
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

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/ds-usage',
    handler: apiHandler,
  }), 'ds-usage: api route')

  ctx.effect(function () {
    return function () {
      stopLoginPoll()
      if (edgeHandle) { try { edgeHandle.terminate() } catch (e) { /* ignore */ } edgeHandle = null }
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
  if (subprocess !== undefined) {
    nodeRun(['discover']).then(function (d) {
      if (!d || (!d.edge && !d.chrome)) console.error('ds-usage: 未检测到 Edge/Chrome 浏览器')
    }).catch(function (e) {
      console.error('ds-usage: node 助手不可用:', e)
    })
  }
}
