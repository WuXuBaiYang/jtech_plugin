# ds-deepseek-usage

DeepSeek 账号用量监视插件 —— 为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) Web/桌面端提供仿游戏风格的 **HP/MP 侧边栏模块**。

- **HP 条** = 账户余额(含赠金/充值拆分)
- **MP 条** = Token 用量(点击切换 **今日 / 本月**,共用同一刻度)
- **同步状态行** = 上次同步时间 + 实时指示灯

## 功能

- **余额 + 用量同步引擎**:每小时(仅页面可见时)拉取平台账号余额、今日/本月 Token 用量与费用
- **扫码登录(内置 CLI)**:侧边栏点击 **⚡ 扫码登录**,host 自动调用随包分发的 `login-cli.mjs`(微信扫码登录 CLI)完成登录,二维码直接显示在插件里
- **实时本地计数**:监听 `llm/stream` 事件,实时累加本次进程内产生的 Token 用量(今日/本月/分模型),平台尚未同步前即可看到增量
- **文件持久化**:状态(含登录态)保存在 `$DSH_HOME/ds-deepseek-usage.json`,重启不丢

## 架构

| 文件 | 职责 |
| --- | --- |
| `index.js` | Host 半区(服务端):同步引擎、CLI 扫码登录(调内置 login-cli.mjs)、token 文件读取/重载、`llm/stream` 计数、HTTP API `/api/ds-usage`、文件持久化 |
| `login-cli.mjs` | 内置微信扫码登录 CLI(随包分发,非独立工具;支持 `--json-lines`/`--token-file` 等) |

> 登录方式:侧边栏 **⚡ 扫码登录** → host 调用包内 `login-cli.mjs`(`--json-lines --token-file <DSH_HOME>/ds-deepseek-usage.token`)→ 二维码回传显示 → 扫码确认后 token 自动生效。
> CLI 随插件包分发,不作为独立工具;如需自定义可用环境变量 `DS_WECHAT_LOGIN_BIN` 覆盖。host 每 10 秒也会检查 token 文件兜底。
| `client.js` | Client 半区(浏览器):通过 `window.__ModuleLoader__` 加载,注入 `sidebar.footer.action` 槽位渲染 HP/MP 模块 |
| `package.json` | 插件元数据(`exports["./client"]` 声明客户端半区) |
| `dsh.plugin.json` | 展示性插件元数据(可选,随包分发,DSH 无硬性读取) |

### 数据流

```
DeepSeek Platform API ──sync──▶ index.js (host) ──state──▶ client.js (浏览器 HP/MP 模块)
   ▲                                  ▲
   └── 微信扫码登录(auth API) ◀──┘      └── llm/stream 实时计数(本地增量)
```

### 数据源接口

- `GET https://platform.deepseek.com/api/v0/users/get_user_summary` —— 余额、累计消费
- `GET https://platform.deepseek.com/api/v0/usage/amount?month=M&year=Y` —— Token 用量
- `GET https://platform.deepseek.com/api/v0/usage/cost?month=M&year=Y` —— 费用

> 均为平台私有面板接口,可能随时变动;认证失败码 `40002`/`40003` 视为登录失效。

## 安装

### 方式一:从 npm 一键安装(推荐,终端用户也用它)

插件已声明 `dsh.bundle.patch`(随包附带 `cordis.patch.yml`),`dsh plugin` 装完会自动把它加入 profile 的 bundles 层并激活,无需手改任何配置文件:

```bash
# 前置:DSH 已安装(dsh 命令可用)、Node >= 22、pnpm 在 PATH 上(dsh plugin 内部转发给 pnpm)

# 安装到 web profile(最常用)
dsh plugin --profile web add ds-deepseek-usage

# 桌面端:用桌面端 App 自建的 profile 名替换 web 即可
# 本版 dsh CLI 内置的 profile 模板为 web / headless
dsh plugin --profile <你的profile> add ds-deepseek-usage
```

> ⚠️ **安装后必须重启 dsh 才生效**:`dsh plugin add` 写入 profile 的 bundles 层,该层只在启动时合成(运行中不监听)。重启前 `POST /api/ds-usage` 返回 404 属正常现象。

验证安装与版本:

```bash
dsh plugin --profile web ls                                    # 应看到 ds-deepseek-usage@最新版
dsh --profile web --dump-config | grep ds-deepseek-usage        # 合成树里应有该插件行
# 重启 dsh web 后:POST /api/ds-usage 请求体 {"method":"state"} 应返回状态而非 404
```

### 方式二:手动安装(本地开发/离线)

1. 把本目录放入 DSH 用户目录的共享插件目录:

   ```powershell
   # Windows 示例;$DSH_HOME 默认是 ~/.dsh
   Copy-Item -Recurse ds-deepseek-usage "$env:USERPROFILE\.dsh\profiles\node_modules\"
   ```

2. 在目标 profile(如 `web`、`headless` 或桌面端自建 profile)的 `cordis.patch.yml` 中挂载:

   ```yaml
   # $DSH_HOME/profiles/<profile>/cordis.patch.yml
   - insert:
       - id: ds-deepseek-usage
         name: ds-deepseek-usage
   ```

### 两种方式之后

**重启** `dsh web` / 桌面端(客户端 bundle 在启动时烘焙,刷新页面不生效)。

> 桌面端(dsh-desktop)会自动把 `profiles/node_modules` 里的用户包 junction 进应用内,无需额外操作。

## 更新

```bash
# 更新到最新版本(依赖范围 ^1.x 会自动拉到最新 1.x)
dsh plugin --profile web update ds-deepseek-usage

# 发布了大版本(2.x)时,需显式重装以更新依赖范围
dsh plugin --profile web remove ds-deepseek-usage
dsh plugin --profile web add ds-deepseek-usage

# 更新后同样必须重启 dsh 生效
dsh web
```

> 与安装一致:更新写入的是 bundle 层,重启后才生效。运行中会话的 client 端改动(`client.js`)可经 client-hmr 免刷新热替换;host 端(`index.js`)需重启。

## 使用

- 未登录:点击 **⚡ 扫码登录**,插件内显示微信二维码(host 调用内置 login-cli.mjs 生成),扫码确认后自动登录;也可手动运行 `node login-cli.mjs --token-file ~/.dsh/ds-deepseek-usage.token` 写 token 文件,插件 10 秒内自动生效
- 已登录:
  - **HP 余额条**:悬停查看充值总额/剩余明细
  - **MP 用量条**:点击在 **今日 ↔ 本月** 间切换;悬停查看每格单位(今日/本月共用同一刻度)
  - 同步状态行:绿灯=正常、黄灯=同步中、红灯=同步出错

## HTTP API

`POST /api/ds-usage`,请求体 `{ "method": "..." }`:

| method | 作用 |
| --- | --- |
| `state` | 取当前状态(客户端轮询用,不触发同步) |
| `tick` | 标记页面可见并尝试同步,返回状态 |
| `hidden` | 标记页面隐藏(暂停按需同步) |
| `syncNow` | 立即同步一次 |
| `loginStart` / `loginCancel` | 开始/取消浏览器登录 |
| `logout` | 清除登录态 |

## 开发与调试

```powershell
node --check index.js   # 语法检查
node --check client.js
```

修改后需要**重启 DSH** 生效:client 端(`client.js`)在已运行的会话中可经 client-hmr 免刷新热替换;host 端(`index.js`)需重启。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 侧边栏看不到模块 / API 返回 404 | 安装/更新后未重启(bundle 层只在启动时合成);或手动安装时 `cordis.patch.yml` 未挂载 |
| 点击 MP 条只换名称、进度不变 | 已修复:今日/本月共用同一刻度(取两者较大者为单位),切换时进度可见变化 |
| 启用插件后对话报错/无法对话 | 已修复:计数逻辑位于 try/catch 中,观察者错误不会破坏主对话流 |
| 登录失败/二维码过期 | 点击 **刷新二维码** 重新获取;若提示微信回调失败,稍后重试 |

## 发布新版本(维护者)

```bash
# 1. 在 package.json 中递增 version(如 1.1.0 -> 1.2.0)
# 2. 发布到 npm(使用带发布权限的 .npmrc)
cd ds-deepseek-usage
npm publish --userconfig /path/to/.npmrc-publish

# 3. 提交并推送,与 GitHub 对齐
git add -A && git commit -m "chore: v1.2.0" && git push
```

> 终端用户执行 `dsh plugin --profile web update ds-deepseek-usage` + 重启即可获得新版本。

## 许可

MIT
