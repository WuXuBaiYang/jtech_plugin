# jtech_plugin

**DeepSeek Harness (DSH) 插件开发仓库** —— 我的 DSH 插件全家桶。

本仓库作为插件开发的统一载体,每个子目录是一个独立的 DSH 插件子项目,各自带 README 与源码,可以单独安装、单独维护。插件通过 **npm 发布**,用户侧用 `dsh plugin add` 一行命令安装。

## 插件列表

| 子项目 | 说明 | 状态 |
| --- | --- | --- |
| [ds-deepseek-usage](./ds-deepseek-usage/) | DeepSeek 账号用量监视 —— 仿游戏风格 HP/MP 侧边栏(余额 + Token 用量,浏览器登录态采集,实时计数) | ✅ 已发布 [npm](https://www.npmjs.com/package/ds-deepseek-usage) |

## 仓库结构

```
jtech_plugin/
├── ds-deepseek-usage/        # 子项目:DeepSeek 用量监视插件
│   ├── index.js              # Host 半区(服务端)
│   ├── client.js             # Client 半区(浏览器 UI)
│   ├── cordis.patch.yml      # bundle patch 层(一键安装时自动应用)
│   ├── package.json          # 含 dsh.bundle / dsh.client 声明
│   └── README.md             # 该插件的独立文档
├── docs/                     # 发布/分发流程调研文档
│   └── dsh-plugin-publish-guide.md
└── README.md                 # 本文件
```

每个新插件按同样模式新增一个子目录即可。

## DSH 插件是什么

DSH(DeepSeek Harness)的插件分为两层:

- **Host 半区(Node)**:通过 `apply(ctx)` 挂载服务、事件监听(`llm/stream`、`timer`、`webServer` 等),暴露 HTTP API
- **Client 半区(浏览器)**:通过 `window.__ModuleLoader__.load()` 注册,用 `ctx.slots` 向 UI 槽位(如 `sidebar.footer.action`)注入界面

插件通过 profile 的 `cordis.patch.yml` 挂载;声明了 `dsh.bundle` 的包由 `dsh plugin` 自动对账进 profile 的 bundles 层,无需手改任何配置文件。

## 安装一个插件到 DSH

以 web profile 为例(desktop profile 同理,把 `web` 换成 `desktop` 即可):

```powershell
# 一键安装(自动加入 profile bundles 层并激活)
dsh plugin --profile web add ds-deepseek-usage

# 升级 / 卸载
dsh plugin --profile web update ds-deepseek-usage
dsh plugin --profile web remove ds-deepseek-usage
```

> 前置:本机需要 `pnpm` 在 PATH 上(`dsh plugin` 内部转发给 pnpm);插件是 npm 公开包,安装后**重启** DSH(客户端 bundle 在启动时烘焙,插件集变更需重启生效)。

### 手动安装(本地开发/离线)

```powershell
# 1. 把插件目录放进共享插件目录
Copy-Item -Recurse ds-deepseek-usage "$env:USERPROFILE\.dsh\profiles\node_modules\"

# 2. 在目标 profile 的补丁层挂载
#    $env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml
#    - insert:
#        - id: ds-deepseek-usage
#          name: ds-deepseek-usage

# 3. 重启 dsh web / 桌面端
```

## 发布一个插件到 npm

```sh
cd <plugin-dir>
npm login                  # 一次即可;账号开启 2FA 时需提供 OTP 或使用 bypass-2FA 的 granular token
npm pack                   # 检查 .tgz 内容(files 字段决定;勿漏 cordis.patch.yml)
npm publish                # 非作用域名直接公开
```

发布后用户即可 `dsh plugin --profile web add <包名>` 一键安装。完整调研见 [docs/dsh-plugin-publish-guide.md](./docs/dsh-plugin-publish-guide.md)。

## 新增一个子项目

```powershell
# 1. 在仓库下建目录
mkdir my-new-plugin

# 2. 至少包含:
#    package.json      # name / main / exports["./client"] / dsh.bundle / dsh.client 声明
#    index.js          # Host 半区
#    client.js         # Client 半区(可选,纯 Host 插件可省略)
#    cordis.patch.yml  # 插件行插入组合树(需写进 files)
#    README.md         # 独立文档

# 3. 发布到 npm,安装方式同上
```

## 环境要求

- Node.js ≥ 22(插件 `engines` 要求)
- DSH(`@deepseek-ai/dsh`),提供 `webServer`、`subprocess`、`timer`、`llm` 等服务
- 桌面端:dsh-desktop(自动链接 `profiles/node_modules` 中的用户包)

## 许可

MIT(各子项目如无特殊说明均遵循)
