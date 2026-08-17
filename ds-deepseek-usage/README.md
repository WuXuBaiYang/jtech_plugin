# ds-deepseek-usage

DeepSeek 账号用量监视插件 —— 为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) Web/桌面端提供仿游戏风格的 **HP/MP 侧边栏模块**。

- **HP 条** = 账户余额(含赠金/充值拆分)
- **MP 条** = Token 用量(点击切换 **今日 / 本月**,共用同一刻度)
- **同步状态行** = 上次同步时间 + 实时指示灯

## 功能

- **余额 + 用量同步引擎**:每小时(仅页面可见时)拉取平台账号余额、今日/本月 Token 用量与费用
- **浏览器登录态采集**:通过 CDP 打开 Edge/Chrome(专用 profile)登录 DeepSeek Platform,自动抓取 `userToken` 并校验,无需手动填 Token
- **实时本地计数**:监听 `llm/stream` 事件,实时累加本次进程内产生的 Token 用量(今日/本月/分模型),平台尚未同步前即可看到增量
- **文件持久化**:状态(含登录态)保存在 `$DSH_HOME/ds-deepseek-usage.json`,重启不丢

## 架构

| 文件 | 职责 |
| --- | --- |
| `index.js` | Host 半区(服务端):同步引擎、登录流程、`llm/stream` 计数、HTTP API `/api/ds-usage`、文件持久化 |
| `client.js` | Client 半区(浏览器):通过 `window.__ModuleLoader__` 加载,注入 `sidebar.footer.action` 槽位渲染 HP/MP 模块 |
| `package.json` | 插件元数据(`exports["./client"]` 声明客户端半区) |
| `dsh.plugin.json` | 展示性插件元数据(可选,随包分发,DSH 无硬性读取) |

### 数据流

```
DeepSeek Platform API ──sync──▶ index.js (host) ──state──▶ client.js (浏览器 HP/MP 模块)
   ▲                                  ▲
   └── CDP 浏览器登录采集 ◀──┘          └── llm/stream 实时计数(本地增量)
```

### 数据源接口

- `GET https://platform.deepseek.com/api/v0/users/get_user_summary` —— 余额、累计消费
- `GET https://platform.deepseek.com/api/v0/usage/amount?month=M&year=Y` —— Token 用量
- `GET https://platform.deepseek.com/api/v0/usage/cost?month=M&year=Y` —— 费用

> 均为平台私有面板接口,可能随时变动;认证失败码 `40002`/`40003` 视为登录失效。

## 安装

### 方式一:从 npm 一键安装(推荐)

插件已声明 `dsh.bundle.patch`(随包附带 `cordis.patch.yml`),`dsh plugin` 装完会自动把它加入 profile 的 bundles 层并激活,无需手改任何配置文件:

```powershell
# web profile
dsh plugin --profile web add ds-deepseek-usage

# 桌面端 profile
dsh plugin --profile desktop add ds-deepseek-usage
```

> 需要本机 `pnpm` 在 PATH 上(`dsh plugin` 内部转发给 pnpm)。

### 方式二:手动安装(本地开发/离线)

1. 把本目录放入 DSH 用户目录的共享插件目录:

   ```powershell
   # Windows 示例;$DSH_HOME 默认是 ~/.dsh
   Copy-Item -Recurse ds-deepseek-usage "$env:USERPROFILE\.dsh\profiles\node_modules\"
   ```

2. 在目标 profile(如 `web`、`desktop`)的 `cordis.patch.yml` 中挂载:

   ```yaml
   # $DSH_HOME/profiles/<profile>/cordis.patch.yml
   - insert:
       - id: ds-deepseek-usage
         name: ds-deepseek-usage
   ```

### 两种方式之后

**重启** `dsh web` / 桌面端(客户端 bundle 在启动时烘焙,刷新页面不生效)。

> 桌面端(dsh-desktop)会自动把 `profiles/node_modules` 里的用户包 junction 进应用内,无需额外操作。

## 使用

- 未登录:点击模块 **⚡ 登录**,会弹出 Edge/Chrome 登录 DeepSeek Platform,完成后自动关闭浏览器
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

修改后同样需要**重启 DSH** 才能生效。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 侧边栏看不到模块 / API 返回 404 | profile 的 `cordis.patch.yml` 未挂载,或未重启 |
| 点击 MP 条只换名称、进度不变 | 已修复:今日/本月共用同一刻度(取两者较大者为单位),切换时进度可见变化 |
| 启用插件后对话报错/无法对话 | 已修复:计数逻辑位于 try/catch 中,观察者错误不会破坏主对话流 |
| 登录失败提示找不到浏览器 | 需要本机安装 Edge 或 Chrome,且宿主提供 `subprocess` 服务 |

## 许可

MIT
