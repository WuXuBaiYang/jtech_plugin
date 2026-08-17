// ds-deepseek-usage — static Client half (hand-written web bundle), v3.1.
// Logo + login button (not logged in) / HP bar (balance) + MP bar (usage)
// with mode cycling on click (logged in). No popups.
window.__ModuleLoader__.load({
  id: 'ds-deepseek-usage',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    function rpc(method) {
      return fetch('/api/ds-usage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method }),
      }).then(function (r) { return r.json() }).then(function (d) {
        if (d && d.error) throw new Error(d.error)
        return d
      })
    }

    function el(t, p) {
      const children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(null, [t, p].concat(children))
    }
    function fmtNum(n) { return String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') }
    function fmtCompactTokens(n) {
      if (n >= 1000000000) return (n / 1000000000).toFixed(1) + 'B'
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
      if (n >= 10000) return (n / 1000).toFixed(1) + 'k'
      return fmtNum(n)
    }
    function fmtMoney(n, cur) {
      if (n >= 10000) return cur + (n / 1000).toFixed(1) + 'k'
      return cur + Number(n || 0).toFixed(2)
    }
    function fmtTime(ts) {
      const d = new Date(ts)
      const p = function (n) { return n < 10 ? '0' + n : String(n) }
      return p(d.getHours()) + ':' + p(d.getMinutes())
    }
    function expPct(n) {
      if (n <= 0) return 0
      const cap = Math.pow(10, String(Math.floor(n)).length)
      return Math.max(4, Math.min(100, Math.round(n / cap * 100)))
    }
    const MODES = ['today', 'month']
    function modeInfo(state, modeIdx) {
      const mode = MODES[modeIdx] || 'today'
      if (mode === 'month') return { label: '本月', tokens: state.month.tokens }
      return { label: '今日', tokens: state.today.tokens }
    }
    function fmtUnit(n) {
      if (n >= 1000000000) return (n / 1000000000) + 'B'
      if (n >= 1000000) return (n / 1000000) + 'M'
      if (n >= 1000) return (n / 1000) + 'k'
      return String(n)
    }
    // 共享刻度:单位取自 今日/本月 中较大者(一般即本月),两条 MP 条在同一
    // 把尺上,点击切换时进度才会有可感知差异(各自按自身量级取单位会让两档
    // 都停在约 1 格的位置,看不出变化)。
    function mpSegs(todayTokens, monthTokens) {
      const ref = Math.max(todayTokens, monthTokens, 1)
      if (ref <= 0) return { unit: 1000000, today: 0, month: 0 }
      const exp = Math.floor(Math.log10(ref))
      const unit = Math.min(1000000000, Math.pow(10, Math.max(6, exp)))
      return { unit: unit, today: todayTokens / unit, month: monthTokens / unit }
    }

    const CSS = `
/* 槽位宿主由 shell 渲染为 data-slot 属性 + 内联 display:contents(@deepseek-ai/dsh-client-web-react
   ANCHOR_STYLE),因此这里必须 !important 才能覆盖成纵向模块堆叠;
   :has(.ds-module) 把该布局效果限定在本模块挂载时,同槽位其他插件的条目不受影响;
   data-slot 属性是官方客户端(CSS 里同样使用)稳定的渲染契约。 */
[data-slot="sidebar.footer.action"]:has(.ds-module){display:flex !important;flex-direction:column;align-items:stretch;gap:6px;width:100%}
.ds-module{display:flex;flex-direction:row;align-items:center;gap:7px;width:100%;flex:none}
.ds-logo{width:26px;height:26px;border-radius:8px;flex:none;align-self:center;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#06121f;background:linear-gradient(135deg,#3ddc7a 0 50%,#3f9dff 50% 100%);box-shadow:0 0 8px rgba(80,180,255,.35);letter-spacing:.5px;font-family:ui-monospace,Consolas,monospace}
.ds-body{display:flex;flex-direction:column;gap:5px;flex:1;min-width:0}
.ds-mini{display:flex;align-items:center;justify-content:center;gap:6px;border:1px solid rgba(90,130,190,.28);background:rgba(18,32,64,.5);cursor:pointer;padding:6px 10px;border-radius:10px;min-height:32px;font-family:ui-monospace,Consolas,monospace;color:#a9c2e8;width:100%}
.ds-mini:hover{background:rgba(30,52,100,.75);border-color:rgba(120,170,255,.45)}
.ds-mini-login{display:flex;align-items:center;gap:5px;font-size:11px;color:#ffb454;font-weight:700}
.ds-mini-busy{display:flex;align-items:center;gap:6px;font-size:11px;color:#9fc4f5;font-weight:700}
.ds-mini-err{display:flex;align-items:center;gap:5px;font-size:11px;color:#ff8d7a;font-weight:700}
.ds-qr{display:flex;flex-direction:column;align-items:center;gap:6px;width:100%}
.ds-qr img{border-radius:8px;border:1px solid rgba(90,130,190,.35);background:#fff;padding:6px}
.ds-qr-status{font-size:10px;color:#9fc4f5;text-align:center;line-height:1.4}
.ds-qr-err{color:#ff8d7a}
.ds-spin{width:10px;height:10px;border-radius:50%;border:2px solid #1e3054;border-top-color:#3f9dff;animation:ds-spin 1s linear infinite;flex:none}
.ds-bar{position:relative;height:16px;border-radius:4px;background:#070c18;border:1px solid #1c2c50;overflow:hidden;width:100%}
.ds-bar-fill{position:absolute;left:0;top:0;bottom:0;border-radius:3px;transition:width .6s cubic-bezier(.2,.8,.3,1)}
.ds-bar-hp{background:linear-gradient(90deg,#2fbf5f,#1c9c48);box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 0 8px rgba(60,220,120,.3)}
.ds-bar-hp-empty{background:linear-gradient(90deg,#e0523d,#b8321f);box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 0 8px rgba(240,90,60,.3)}
.ds-bar-mp{background:linear-gradient(90deg,#3f9dff,#2666d8);box-shadow:inset 0 1px 0 rgba(255,255,255,.3),0 0 8px rgba(70,150,255,.35)}
.ds-bar-mp.live{background-size:200% 100%;animation:ds-shine 1.6s linear infinite}
.ds-bar-seg{position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0 calc(10% - 1px),rgba(0,0,0,.4) calc(10% - 1px) 10%);pointer-events:none}
.ds-bar-text{position:absolute;inset:0;display:flex;align-items:center;justify-content:space-between;padding:0 7px;font-size:10px;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.85);font-family:ui-monospace,Consolas,monospace;white-space:nowrap;overflow:hidden;pointer-events:none}
.ds-bar-text span:last-child{flex:none}
.ds-bar-text span:first-child{overflow:hidden;text-overflow:ellipsis}
.ds-mp-click{cursor:pointer}
.ds-mp-click:hover{filter:brightness(1.15)}
.ds-sync-line{display:flex;align-items:center;gap:5px;font-size:9px;color:#5d7aa8;font-family:ui-monospace,Consolas,monospace;min-height:12px;padding:0 2px}
.ds-led{width:6px;height:6px;border-radius:50%;background:#38c35f;box-shadow:0 0 5px #38c35f;flex:none}
.ds-led.busy{background:#ffb020;box-shadow:0 0 5px #ffb020;animation:ds-blink 1s infinite}
.ds-led.err{background:#e74c3c;box-shadow:0 0 5px #e74c3c}
@keyframes ds-spin{to{transform:rotate(360deg)}}
@keyframes ds-shine{0%{background-position:200% 0}100%{background-position:-200% 0}}
@keyframes ds-blink{50%{opacity:.35}}
`

    const inject = ['slots', 'timer']

    function apply(ctx) {
      ctx.effect(function () {
        const style = document.createElement('style')
        style.dataset.plugin = 'ds-deepseek-usage'
        style.textContent = CSS
        document.head.appendChild(style)
        return function () { style.remove() }
      }, 'ds-usage: styles')

      // 微信扫码登录:host 半区通过平台 auth API 驱动 uuid -> 轮询 -> code -> token,
      // 本组件只负责渲染二维码与状态(状态来自 host 的 state.login 字段)。
      function QrLogin({ state, setState }) {
        const l = state.login || { phase: null }
        const [busy, setBusy] = React.useState(false)
        const start = function () {
          setBusy(true)
          rpc('loginStart').then(function () {
            rpc('state').then(setState).catch(function () {})
          }).catch(function () {}).finally(function () { setBusy(false) })
        }
        const cancel = function () {
          rpc('loginCancel').then(function () { rpc('state').then(setState).catch(function () {}) }).catch(function () {})
        }
        const retry = start
        let body = null
        if (l.phase === 'waiting' || l.phase === 'scanned' || l.phase === 'done') {
          body = el('div', { className: 'ds-qr' },
            el('img', { src: l.qrImageUrl, alt: '微信扫码登录', width: 120, height: 120 }),
            el('div', { className: 'ds-qr-status' }, l.phase === 'scanned' ? '已扫码，请在手机上确认 ✓' : '请使用微信扫码登录'),
            el('button', { className: 'ds-mini', onClick: cancel, title: '取消登录' }, el('span', null, '取消')),
          )
        } else if (l.phase === 'expired' || l.phase === 'error') {
          body = el('div', { className: 'ds-qr' },
            el('div', { className: 'ds-qr-status ds-qr-err' }, '⚠ ' + (l.error || '二维码已过期')),
            el('button', { className: 'ds-mini', onClick: retry, title: '重新获取二维码' }, el('span', null, '刷新二维码')),
          )
        } else {
          body = el('button', {
            className: 'ds-mini',
            title: 'DeepSeek 用量（未登录，微信扫码登录）',
            'aria-label': 'DeepSeek 用量',
            onClick: busy ? null : start,
          }, el('span', { className: 'ds-mini-login' }, busy ? '获取二维码…' : '⚡ 扫码登录'))
        }
        return el('div', { className: 'ds-body' }, body)
      }

      function UsageBars({ state, modeIdx, setModeIdx }) {
        const cur = state.currency === 'CNY' || state.currency === 'CNH' ? '¥' : '$'
        const bal = state.balance || { total: 0, toppedUp: 0, granted: 0, available: false }
        const totalCost = Number(state.totalCost || 0)
        const hpMax = Math.max(1, bal.total + totalCost)
        const hpPct = bal.available ? Math.max(0, Math.min(100, Math.round(bal.total / hpMax * 100))) : 0
        const hpCls = bal.available ? 'ds-bar-hp' : 'ds-bar-hp-empty'
        const mode = modeInfo(state, modeIdx)
        // 今日/本月共用同一刻度(单位取自两者中较大者),点击切换时进度随之变化。
        const seg = mpSegs(state.today.tokens, state.month.tokens)
        const filled = modeIdx === 1 ? seg.month : seg.today
        // 有量时给 4% 最低可见宽度,避免今日档在本月大尺度下显得像空条。
        const mpFill = filled > 0
          ? Math.max(4, Math.min(100, Math.round(filled / 10 * 100)))
          : 0
        const live = state.localDelta && state.localDelta.today > 0
        const ledCls = state.syncing ? 'busy' : (state.syncError ? 'err' : '')
        const syncText = state.syncing ? '同步中…' : (state.syncError ? ('⚠ ' + state.syncError) : (state.lastSyncAt ? ('上次同步 ' + fmtTime(state.lastSyncAt)) : '尚未同步'))
        const hpTitle = 'HP 余额 · 充值总额（含已用）' + fmtMoney(bal.total + totalCost, cur) + ' · 剩余 ' + fmtMoney(bal.total, cur)
        const mpTitle = 'MP 用量 · 每格 ' + fmtUnit(seg.unit) + '（满条 ' + fmtUnit(seg.unit * 10) + '）· 点击切换 今日/本月'

        return el('div', { className: 'ds-body', style: { padding: 0 } },
          el('div', { className: 'ds-bar', title: hpTitle },
            el('div', { className: 'ds-bar-fill ' + hpCls, style: { width: hpPct + '%' } }),
            el('div', { className: 'ds-bar-seg' }),
            el('div', { className: 'ds-bar-text' },
              el('span', null, 'HP 余额'),
              el('span', null, fmtMoney(bal.total, cur)),
            ),
          ),
          el('div', {
            className: 'ds-bar ds-mp-click',
            title: mpTitle,
            onClick: function () { setModeIdx((modeIdx + 1) % MODES.length) },
          },
            el('div', { className: 'ds-bar-fill ds-bar-mp' + (live ? ' live' : ''), style: { width: mpFill + '%' } }),
            el('div', { className: 'ds-bar-seg' }),
            el('div', { className: 'ds-bar-text' },
              el('span', null, 'MP ' + mode.label),
              el('span', null, fmtCompactTokens(mode.tokens) + ' tk'),
            ),
          ),
          el('div', { className: 'ds-sync-line' },
            el('span', { className: 'ds-led' + (ledCls ? ' ' + ledCls : '') }),
            el('span', null, syncText),
          ),
        )
      }

      function DsUsageModule() {
        const [state, setState] = React.useState(null)
        const [modeIdx, setModeIdx] = React.useState(0)
        React.useEffect(function () {
          const applyState = function (s) { if (s) setState(s) }
          const tick = function () {
            rpc('tick').then(applyState).catch(function () {})
          }
          tick()
          const poll = ctx.interval(function () {
            rpc('state').then(applyState).catch(function () {})
          }, 2500)
          const syncTick = ctx.interval(tick, 60000)
          let rmVis = null
          if (typeof document !== 'undefined' && document.addEventListener) {
            const vis = function () {
              if (document.visibilityState === 'hidden') {
                rpc('hidden').catch(function () {})
              } else {
                tick()
              }
            }
            document.addEventListener('visibilitychange', vis)
            rmVis = function () { document.removeEventListener('visibilitychange', vis) }
          }
          return function () {
            poll()
            syncTick()
            if (rmVis) rmVis()
            rpc('hidden').catch(function () {})
          }
        }, [])

        const body = state === null
          ? el('button', { className: 'ds-mini', 'aria-label': 'DeepSeek 用量' }, el('span', { className: 'ds-mini-busy' }, '…'))
          : !state.loggedIn
            ? React.createElement(QrLogin, { state: state, setState: setState })
            : React.createElement(UsageBars, { state: state, modeIdx: modeIdx, setModeIdx: setModeIdx })

        return el('div', { className: 'ds-module' },
          el('span', { className: 'ds-logo' }, 'DS'),
          el('div', { className: 'ds-body' }, body),
        )
      }

      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'ds-usage', order: -1, label: 'DeepSeek 用量' },
          function (props) {
            if (props && props.wide === false) return null
            return React.createElement(DsUsageModule, null)
          },
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
