# jtech_plugin

**DeepSeek Harness (DSH) 插件开发仓库** —— 我的 DSH 插件全家桶。

本仓库作为插件开发的统一载体,每个子目录是一个独立的 DSH 插件子项目,各自带 README 与源码,可以单独安装、单独维护。

## 插件列表

| 子项目 | 说明 | 状态 |
| --- | --- | --- |
| [ds-deepseek-usage](./ds-deepseek-usage/) | DeepSeek 账号用量监视 —— 仿游戏风格 HP/MP 侧边栏(余额 + Token 用量,浏览器登录态采集,实时计数) | ✅ 可用 |

## 仓库结构

```
jtech_plugin/
├── ds-deepseek-usage/        # 子项目:DeepSeek 用量监视插件
│   ├── index.js              # Host 半区(服务端)
│   ├── client.js             # Client 半区(浏览器 UI)
│   ├── package.json
│   └── README.md             # 该插件的独立文档
└── README.md                 # 本文件
```

每个新插件按同样模式新增一个子目录即可。

## DSH 插件是什么

DSH(DeepSeek Harness)的插件分为两层:

- **Host 半区(Node)**:通过 `apply(ctx)` 挂载服务、事件监听(`llm/stream`、`timer`、`webServer` 等),暴露 HTTP API
- **Client 半区(浏览器)**:通过 `window.__ModuleLoader__.load()` 注册,用 `ctx.slots` 向 UI 槽位(如 `sidebar.footer.action`)注入界面

插件通过 profile 的 `cordis.patch.yml` 挂载,包体放在 `$DSH_HOME/profiles/node_modules/` 下。

## 安装一个插件到 DSH

以 web profile 为例(通用步骤,详见各子项目 README):

```powershell
# 1. 把插件目录放进共享插件目录
Copy-Item -Recurse <plugin-dir> "$env:USERPROFILE\.dsh\profiles\node_modules\"

# 2. 在目标 profile 的补丁层挂载
#    $env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml
#    - insert:
#        - id: <plugin-name>
#          name: <plugin-name>

# 3. 重启 dsh web / 桌面端(客户端 bundle 启动时烘焙,必须重启)
```

## 新增一个子项目

```powershell
# 1. 在仓库下建目录
mkdir my-new-plugin

# 2. 至少包含:
#    package.json      # name / main / exports["./client"] / dsh.client 声明
#    index.js          # Host 半区
#    client.js         # Client 半区(可选,纯 Host 插件可省略)
#    README.md         # 独立文档

# 3. 挂载与安装方式同上
```

## 环境要求

- Node.js ≥ 22(插件 `engines` 要求)
- DSH(`@deepseek-ai/dsh`),提供 `webServer`、`subprocess`、`timer`、`llm` 等服务
- 桌面端:dsh-desktop(自动链接 `profiles/node_modules` 中的用户包)

## 许可

MIT(各子项目如无特殊说明均遵循)
