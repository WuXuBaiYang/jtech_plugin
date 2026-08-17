#!/usr/bin/env node
// ds-wechat-login — DeepSeek 开放平台微信扫码登录 CLI。
// 纯接口实现(无需浏览器/CDP),流程:
//   uuid(open.weixin.qq.com f=xml) → 二维码图 → 轮询微信登录状态 →
//   code → 平台回调换 nonce → /oauth/get_token 换 userToken。
// 接口契约均经实机验证(2026-08)。
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const WX_APPID = 'wx335255e1b73f9e52'
const WX_CALLBACK = 'https://platform.deepseek.com/auth-api/v0/users/oauth/wechat/callback'
const QR_BASE = 'https://open.weixin.qq.com/connect/qrconnect'
const POLL_BASE = 'https://long.open.weixin.qq.com/connect/l/qrconnect'
const AUTH_BASE = 'https://platform.deepseek.com/auth-api/v0/users'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function qrUrl() {
  return QR_BASE +
    '?appid=' + WX_APPID +
    '&scope=snsapi_login&redirect_uri=' + encodeURIComponent(WX_CALLBACK) +
    '&state=&login_type=jssdk&self_redirect=false&stylelite=1&fast_login=0'
}

/** 1. 获取微信登录二维码 uuid */
async function fetchUuid() {
  const res = await fetch(qrUrl() + '&f=xml&' + Date.now(), {
    headers: { 'User-Agent': UA, Accept: 'text/xml, application/xml, */*' },
  })
  const xml = await res.text()
  const m = xml.match(/<uuid><!\[CDATA\[([^\]]+)\]\]><\/uuid>/) || xml.match(/<uuid>([^<]+)<\/uuid>/)
  if (!m) throw new Error('获取二维码 uuid 失败: ' + xml.slice(0, 160))
  return m[1]
}

/** 2. 下载二维码 PNG 并展示 */
async function showQr(uuid, mode) {
  const pngUrl = 'https://open.weixin.qq.com/connect/qrcode/' + uuid
  if (mode === 'url') return { pngUrl }
  const res = await fetch(pngUrl, { headers: { 'User-Agent': UA } })
  const buf = Buffer.from(await res.arrayBuffer())
  const dir = mkdtempSync(join(tmpdir(), 'ds-wx-login-'))
  const file = join(dir, 'qr.png')
  writeFileSync(file, buf)
  if (mode === 'browser' || mode === 'open') {
    const cmd = process.platform === 'darwin' ? 'open' : (process.platform === 'linux' ? 'xdg-open' : null)
    if (cmd) {
      spawn(cmd, [file], { stdio: 'ignore', detached: true }).unref()
      return { pngUrl, file, opened: true }
    }
  }
  return { pngUrl, file, opened: false }
}

/** 3. 轮询微信登录状态;返回 wx_code(用户确认后出现) */
async function poll(uuid, onStatus, timeoutMs = 300000) {
  const start = Date.now()
  let last = ''
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(POLL_BASE + '?uuid=' + encodeURIComponent(uuid) + '&_=' + Date.now(), {
      headers: { 'User-Agent': UA, Accept: 'text/javascript, */*' },
    })
    const body = await res.text()
    const err = (body.match(/wx_errcode\s*=\s*(\d+)/) || [])[1]
    const code = (body.match(/wx_code\s*=\s*'([^']*)'/) || [])[1] || ''
    const status = code ? 'confirmed' : (err === '405' ? 'scanned' : (err === '402' ? 'expired' : 'waiting'))
    if (status !== last) { onStatus(status); last = status }
    if (code) return code
    if (err === '402') throw new Error('二维码已过期,请重新运行')
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('等待扫码超时')
}

/** 4. code → 平台回调(307 Location 里的 nonce) → get_token → userToken */
async function exchange(code) {
  const cbUrl = WX_CALLBACK + '?code=' + encodeURIComponent(code) + '&state='
  const cb = await fetch(cbUrl, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', Origin: 'https://platform.deepseek.com', Referer: 'https://open.weixin.qq.com/' },
    redirect: 'manual',
  })
  let nonce = null
  const loc = cb.headers.get('location') || ''
  const m = loc.match(/\bnonce=([^&]+)/)
  if (m) nonce = m[1]
  if (!nonce) {
    const fin = await fetch(cbUrl, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }, redirect: 'follow' })
    const fm = fin.url.match(/\bnonce=([^&]+)/)
    if (fm) nonce = fm[1]
  }
  if (!nonce) throw new Error('微信回调未返回 nonce(location: ' + loc.slice(0, 120) + ')')
  const gt = await fetch(AUTH_BASE + '/oauth/get_token', {
    method: 'POST',
    headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', Origin: 'https://platform.deepseek.com', Referer: 'https://platform.deepseek.com/sign_in' },
    body: JSON.stringify({ nonce, provider: 'WECHAT' }),
  })
  const j = await gt.json()
  const token = j && j.data && j.data.biz_data && j.data.biz_data.token
  if (!token) throw new Error('获取 token 失败: ' + JSON.stringify(j).slice(0, 200))
  return token
}

/** 5. 用 token 验证并显示余额 */
async function fetchBalance(token) {
  const res = await fetch('https://platform.deepseek.com/api/v0/users/get_user_summary', {
    headers: { 'User-Agent': UA, Accept: 'application/json', Authorization: 'Bearer ' + token },
  })
  const j = await res.json()
  const w = j && j.data && j.data.biz_data
  if (!w) return null
  const wallets = (w.normal_wallets || []).map((x) => x.currency + ' ' + Number(x.balance).toFixed(2)).join(', ')
  const bonus = (w.bonus_wallets || []).map((x) => '赠金 ' + x.currency + ' ' + Number(x.balance).toFixed(2)).join(', ')
  return { wallets, bonus: bonus || null }
}

function parseArgs(argv) {
  const out = { json: false, balance: false, qrMode: 'open', tokenFile: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--balance') out.balance = true
    else if (a === '--qr') out.qrMode = argv[++i] || 'open'
    else if (a === '--token-file') out.tokenFile = argv[++i]
    else if (a === '--help' || a === '-h') { out.help = true }
  }
  return out
}

const HELP = `ds-wechat-login — DeepSeek 开放平台微信扫码登录 CLI

用法:
  ds-wechat-login [选项]

选项:
  --qr <open|browser|url>   二维码展示方式(默认 open,自动用系统看图工具打开;
                            url 只打印链接,适合无图形环境)
  --balance                 登录后查询并显示账户余额
  --token-file <path>       把 userToken 写入指定文件
  --json                    以 JSON 输出结果
  -h, --help                显示帮助

示例:
  ds-wechat-login --balance --token-file ~/.deepseek-token
`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(HELP); return }
  const log = (s) => { if (!args.json) console.log(s) }

  log('▶ 正在获取微信登录二维码...')
  const uuid = await fetchUuid()
  const qr = await showQr(uuid, args.qrMode)
  log('▶ 二维码图片: ' + qr.pngUrl)
  if (qr.file && qr.opened) log('▶ 已用系统看图工具打开二维码,请用微信扫描')
  else if (qr.file) log('▶ 二维码已保存到 ' + qr.file + ',请打开后用微信扫描')

  const code = await poll(uuid, (s) => {
    log('  · ' + ({ waiting: '等待扫码…', scanned: '已扫码,请在手机上确认 ✓', confirmed: '已确认,正在换取 token…', expired: '二维码已过期' })[s] || s)
  })
  log('▶ 已确认,正在换取 token…')
  const token = await exchange(code)

  if (args.tokenFile) { writeFileSync(args.tokenFile, token + '\n'); log('▶ token 已写入 ' + args.tokenFile) }

  let balance = null
  if (args.balance) {
    try { balance = await fetchBalance(token) } catch (e) { balance = { error: String(e && e.message || e) } }
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: true, token, balance, qrUrl: qr.pngUrl }, null, 2))
  } else {
    console.log('')
    console.log('✅ 登录成功!')
    console.log('userToken: ' + token)
    if (balance && balance.wallets) console.log('余额: ' + balance.wallets + (balance.bonus ? ' | ' + balance.bonus : ''))
    if (balance && balance.error) console.log('余额查询失败: ' + balance.error)
    console.log('')
    console.log('提示: 该 token 可作为 Authorization: Bearer <token> 调用 DeepSeek 开放平台 API。')
  }
}

main().catch((e) => {
  console.error('✗ ' + (e && e.message || e))
  process.exit(1)
})
