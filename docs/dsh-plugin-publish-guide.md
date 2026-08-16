# DSH 插件发布/分发流程调研

> 调研日期:2026-08-16
> 调研对象:DeepSeek Harness (DSH) 插件(`@deepseek-ai/dsh`,当前版本 0.1.0-rc.6)的发布与分发机制;并评估本仓库插件 `ds-deepseek-usage` 距可发布还差什么。
> 方法:只依据一手来源 —— 官方文档(在线 + 本机 npm 包内)、官方源码/CLI 行为、npm 官方机制、registry 实测。每条结论均标注来源。

---

## 结论摘要(一页速览)

1. **DSH 插件的官方分发渠道就是普通 npm 包**,没有专用注册表/市场。官方发布文档明确给出三种分发形态:**发布到 npm**、**交付 tarball**(`pnpm pack`)、**从 GitHub 直接安装**(`github:user/repo`)。安装统一走 `dsh plugin --profile <name> add <pkg>`(内部转发给 profile 目录里的 pnpm)。
2. **可被 `dsh plugin add` 一键安装并激活的关键**,是 package.json 里声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 并把 `cordis.patch.yml` 打进包(`files`)。声明了它,`dsh plugin` 装完会自动把它追加进 profile 的 `dsh.profile.bundles` 层列表,该 patch 负责把"插件行"插入组合树。**没有 `dsh.bundle` 的包也能装,但只是普通依赖,不激活任何层,插件不会加载**(CLI 会打印警告)。
3. 带浏览器 UI 的双半区插件,还要满足客户端发现机制:package.json 声明 `dsh.client`(`platform: "web"`)并提供 `exports["./client"]`,且该包必须是组合树里的一个 loader entry(行 `name` = 包名);运行时由 `@deepseek-ai/dsh-client-modules` 扫描 loader entries、解析 `exports["./client"]`、把产物以 `/plugins/<包名>/client.js` 供给浏览器。
4. **完整发布步骤**:`npm login` → 定版本号 → `npm publish`(非作用域名默认公开;scoped 包默认私有,需 `publishConfig.access: "public"` 或 `--access public`)→ 用户侧 `dsh plugin --profile web|desktop add <pkg>` → **重启 DSH**(客户端 bundle 在启动时烘焙,插件集变更需重启生效)。
5. **官方没有插件市场/收录渠道**。官方文档只提供 npm / tarball / GitHub 三种分发;社区有第三方目录(如 awesome-dsh-plugin、dsh-market)和向官方仓库提议建市场的 Discussion,均非官方。**结论:目前就是"发布到 npm + 在 README/文档里写清安装方式"。**
6. **`ds-deepseek-usage` 目前不能"一键安装"**:package.json 缺 `dsh.bundle` 声明和配套的 `cordis.patch.yml`(现在的安装方式是用户手动往 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里 insert 一行 + 手动放包到 `profiles/node_modules`)。补齐这两样(加 `files` 条目)即可达到 `dsh plugin add ds-deepseek-usage` 开箱即装。其余字段(name 是否占用、README、license 等)基本就绪,详见 §9。

---

## 1. 官方分发渠道与 `dsh plugin add` 怎么装

### 1.1 三种官方分发形态

官方插件开发教程《打包与安装插件》(`docs/user/develop/basic/publish.zh.md`)明确:

- **发布到 npm**:`pnpm publish` 时把 `lib/` 构建好,`dsh plugin add your-package` 安装的就是预构建代码;
- **交付 tarball**:`pnpm pack` 打包,用户执行 `dsh plugin add ./hello-plugin-0.1.0.tgz`;
- **从 GitHub 安装**:`dsh plugin --profile demo add github:you/hello-plugin`(git 安装拿到的是源码不是构建产物,需要作者提供自包含的 `prepare` 脚本,且用户要为构建授权,见 §6.4)。

> 来源:https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/publish.zh.md (2026-08-16 抓取原文,标题《打包与安装插件》)

本机实测佐证 tarball 形态确实存在并被使用:web profile 的依赖就是本地 tarball
`C:\Users\wuxubaiyang\.dsh\profiles\web\package.json`:

```json
"dependencies": {
  "dsh-file-uploads": "file:C:/Users/wuxubaiyang/.dsh/profiles/web/vendor/dsh-file-uploads-v1.0.0.tar.gz"
}
```

> 来源:`C:\Users\wuxubaiyang\.dsh\profiles\web\package.json`(第 5 行)

### 1.2 `dsh plugin` 命令 = pnpm 转发器

`dsh plugin --profile <name> <args...>` 的语义(官方 README 与 CLI 源码):

| 事实 | 来源 |
| --- | --- |
| `dsh plugin` 在 profile 目录内**原样转发给 pnpm**,因此 add/remove/why 等所有 pnpm 子命令都可用 | `@deepseek-ai/dsh\lib\bin.js` 第 96 行(`"manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory"`);`@deepseek-ai/dsh\README.zh.md` 第 14 行 |
| 首次使用某 profile 时自动初始化它(生成 `package.json` + `cordis.patch.yml` + `pnpm-workspace.yaml`);`web`/`headless` 有官方模板(`web` = `[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app]`),其它 profile 初始为 `[@deepseek-ai/dsh-base]` | `@deepseek-ai\dsh-app-boot\lib\index.js` 第 323–334、353–369 行;`@deepseek-ai\dsh\README.zh.md` 第 16 行 |
| 装完后 `dsh plugin` 会**对账**:安装状态里解析到"声明了 `dsh.bundle` 的包"就追加进 `dsh.profile.bundles` 层列表;删掉/失去声明的包就移出列表 | `@deepseek-ai\dsh\lib\plugin-9h8shc4d.js` 第 46–78 行(reconcilePlugins) |
| 装了一个**没声明 `dsh.bundle`** 的包 → 打印警告"installed as a plain dependency, not a profile layer",不激活任何层 | `@deepseek-ai\dsh\lib\plugin-9h8shc4d.js` 第 57 行;官方发布文档"没有 `dsh.bundle` 声明的包仍然可以安装,但只作为普通依赖" |
| 相对路径规格(`./x`、`../x`、`file:...`、`link:...`)会锚定到**你执行 dsh 的目录**,而不是 profile 目录(防止 `add .` 自链接) | `@deepseek-ai\dsh\lib\plugin-9h8shc4d.js` 第 90–94 行(anchorPathSpec) |
| 需要 **pnpm 在 PATH 上**,否则报错 "pnpm not found on PATH" | `@deepseek-ai\dsh\lib\plugin-9h8shc4d.js` 第 113–116 行 |
| git 托管的包安装时若 pnpm 阻止 `prepare` 脚本,`dsh` 会提示把 pnpm 打印的包键加入 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`,再重跑 | `@deepseek-ai\dsh\lib\plugin-9h8shc4d.js` 第 124 行;官方发布文档(见 §6.4) |

### 1.3 profile 的组成与层顺序

profile 目录 = `package.json`(树外插件依赖 + `dsh.profile.bundles` 有序层列表)+ `cordis.patch.yml`(用户自己的 patch 层)。生效配置在空根之上按序叠加:

1. `dsh.profile.bundles` 里各组合包的 patch(按列表顺序);
2. profile 自己的 `cordis.patch.yml`;
3. home 级 `$DSH_HOME/cordis.patch.yml`;
4. 每个 `--patch <path>` overlay(按 argv 顺序)。

后应用的层按行胜出;patch 会**整体替换**目标行的 `config` 值(不是深合并)。

> 来源:`@deepseek-ai\dsh\README.zh.md` 第 30–41 行;`@deepseek-ai\dsh-app-boot\lib\index.js` 第 284–306 行(profile.js 模块注释);官方发布文档《加载顺序》一节

组合包名解析两级:先"安装锚点"(dsh 本体 `@deepseek-ai/dsh` 的依赖闭包),再 profile 目录(`~/.dsh/profiles/<name>/node_modules` + 扁平 fallback `~/.dsh/profiles/node_modules`)。

> 来源:`@deepseek-ai\dsh-app-boot\lib\index.js` 第 518–524 行(resolveBundleDir)、第 409–438 行(healProfilesModuleFallback);`@deepseek-ai\dsh\README.md` 第 39 行

---

## 2. 插件包 package.json 必须满足哪些字段(逐条 + 来源)

官方发布文档给的**最小可安装组合包**范例:

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

> 来源:https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/publish.zh.md (《组合包 manifest》一节)

下面按"加载/发现"相关逐条列出,含双半区(client)插件的额外要求:

### 2.1 与"加载/发现"直接相关的字段

| # | 字段 | 要求 | 来源 |
| --- | --- | --- | --- |
| 1 | `dsh.bundle.patch` | 字符串,指向包内 patch 文件(如 `"./cordis.patch.yml")`。**bundle 的核心声明**:`dsh plugin add` 对账时靠它把包追加进 `dsh.profile.bundles`;boot 时把该 patch 作为配置层应用。层列表里引用的包若没有 `dsh.bundle`,boot 直接失败("declares no dsh.bundle in its package.json") | 官方发布文档;`@deepseek-ai\dsh\lib\plugin-9h8shc4d.js` 第 25–33 行;`@deepseek-ai\dsh-app-boot\lib\index.js` 第 546–549 行 |
| 2 | `cordis.patch.yml`(包内文件) | 顶层 YAML 数组的 patch 条目,把插件行插入组合树。**插件行用 `name` 按包名引用包**(不是相对源码路径),这样 Node 模块解析才能找到已安装的代码。例:`- insert: [{ id: hello, name: dsh-hello-plugin }]`。必须写进 `files` 才会随包发布 | 官方发布文档(含示例);`@deepseek-ai\dsh-app-boot\lib\index.js` 第 57–106 行(applyEntryPatches)、第 833–845 行(parsePatchList) |
| 3 | `main`(或 `exports["."]`) | host 半区插件的入口;loader 按行 `name` import 包时解析它。官方示例 `main: "index.js"`;plugin 模块形如 `export const name = '...'; export function apply(ctx) {...}` | 官方发布文档;`@deepseek-ai\dsh-client-modules\lib\index.js` 与 dsh-file-uploads 等包的实际形态 |
| 4 | `dsh.client`(仅 web 双半区插件) | 对象:`platform` 必须是字符串且为 `"web"` 才被识别;可选 `inject`(字符串数组,表示客户端 bundle 的加载顺序依赖)、可选 `immediately`(布尔)。声明了 `dsh.client` 但没有合法 `exports["./client"]` 会直接抛错 | `@deepseek-ai\dsh-client-modules\lib\index.js` 第 61–73 行(parseDshClient)、第 251–256 行;`@deepseek-ai\dsh-client-modules\README.md` 第 11 行 |
| 5 | `exports["./client"]` | 客户端 bundle 路径:**字符串**,或**含字符串 `default` 的对象**(一层条件形式)。客户端发现机制解析它、哈希成 boot graph,以 `/plugins/<包名>/client.js` 供给浏览器 | `@deepseek-ai\dsh-client-modules\lib\index.js` 第 74–85 行(clientExportOf)、第 91–99 行(graphRow)、第 313–344 行(serveBundle) |
| 6 | 客户端发现的前置条件 | 该包**必须是组合树里的一个 loader entry**(即 §2.1-2 的 patch 行已把它挂上,行 `name` = 包名),且 entry 已激活(`fiber` 存在、未禁用);client-modules 只扫描 `ctx.loader.entries()`,并从 profile 目录(`ctx.baseUrl`)`require.resolve` 该包的 package.json | `@deepseek-ai\dsh-client-modules\lib/index.js` 第 137–139、281–297 行(processOne) |
| 7 | `files` | 必须包含所有要随包分发的文件:`index.js`、`client.js`、`cordis.patch.yml`(以及 README/LICENSE 等)。只列了源码没列 patch 文件 → patch 层丢失,装完不激活 | 官方发布文档示例;`dsh-file-uploads\package.json` 第 33–44 行(对照其 files 与 tar 内容) |
| 8 | `type: "module"` | DSH 插件是 ESM(官方示例与所有官方/社区包均为 `"type": "module"`) | 官方发布文档;`@deepseek-ai\dsh-client-ui-settings-plugins\package.json` 第 13 行;`dsh-file-uploads\package.json` 第 26 行 |

### 2.2 质量/可发布性字段(npm 层面)

| 字段 | 说明 | 来源 |
| --- | --- | --- |
| `name` / `version` / `description` | npm 必需字段;`description` 会显示在 npm 页面 | npm 官方文档(npm-publish);各官方包 |
| `license` | 官方与社区包均声明(多为 MIT);建议再随包放一个 `LICENSE` 文件 | `dsh-file-uploads\package.json` 第 5 行(license)+ 其 tar 内含 LICENSE |
| `publishConfig.access: "public"` | **scoped 包(如 `@你的用户名/...`)默认私有**,必须 `--access public` 或在 `publishConfig` 里声明;非作用域名默认公开,可不写 | npm 官方文档 https://docs.npmjs.com/about-scopes;官方所有 `@deepseek-ai/*` 包均带 `"publishConfig": { "access": "public" }`(如 `@deepseek-ai\dsh-client-ui-settings-plugins\package.json` 第 5–7 行) |
| `keywords` | 官方无强制约定,但社区用 `dsh-plugin`、`deepseek-harness`、`dsh`、`cordis` 等做发现(GitHub topic `dsh-plugin` 有 1800+ 仓库) | `dsh-file-uploads\package.json` 第 18–25 行;网络检索(GitHub topic `dsh-plugin`) |
| `repository` / `homepage` / `bugs` / `author` | 可选,提升可信度与可维护性 | 官方包均带 `repository`(指向 deepseek-harness monorepo 子目录);`dsh-file-uploads\package.json` 第 6–17 行 |
| `engines.node` | 可选;DSH 生态按 Node ≥22 声明 | `dsh-file-uploads\package.json` 第 58–60 行;`ds-deepseek-usage\package.json` 第 23–25 行 |
| `peerDependencies` | 声明对 DSH 服务包 / react 的依赖;社区插件用 `"*"` + `peerDependenciesMeta.optional` 避免版本耦合;注意 profile 的 `pnpm-workspace.yaml` 设置了 `autoInstallPeers: false`,peer 不会自动装进 profile,需从 dsh 安装闭包 / 扁平 fallback 解析 | `dsh-file-uploads\package.json` 第 65–88 行;`@deepseek-ai\dsh-app-boot\lib\index.js` 第 340–345 行(PROFILE_PNPM_WORKSPACE);`@deepseek-ai\dsh-app-boot\lib\index.js` 第 390–408 行(闭包解析说明) |
| `dsh.plugin.json`(包内文件) | **可选元数据**(name/description/version/entry/client)。本地一手来源里未发现任何读取它的代码(官方 Settings 的"插件"页是只读的 loader 快照,读的是 loader entries,不是这个文件),可作展示性补充,不依赖它 | `dsh-file-uploads` 包内 `dsh.plugin.json`;`@deepseek-ai\dsh-host-plugin-inventory\README.md`("Read-only Host projection… 直接读 ctx.loader.entries()");`@deepseek-ai\dsh-client-ui-settings-plugin-inventory\README.md`(read-only 列表) |

### 2.3 发现机制的完整链路(web 双半区插件)

```
用户执行 dsh plugin add <pkg>
  → pnpm 装进 ~/.dsh/profiles/<name>/node_modules
  → reconcile:包声明 dsh.bundle → 追加进 dsh.profile.bundles
  → boot:按 bundles 顺序应用各包 cordis.patch.yml → 插件行(name=包名)进组合树 → loader entry 激活
  → dsh-client-modules 扫 loader entries:
       包声明 dsh.client(platform=web) 且 exports["./client"] 存在
       → 哈希 bundle → window.__DSH_BOOT__ graph → /plugins/<包名>/client.js 供浏览器加载
  → 浏览器侧 window.__ModuleLoader__.load({id, factory}) 注册 → slots.inject(...) 渲染 UI
```

> 来源:§2.1 各条;`@deepseek-ai\dsh-client-modules\README.md` 第 5–11 行(懒加载 CJS 模型、解析分支顺序)

---

## 3. 完整发布步骤

### 3.1 前置:决定包名与可见性

- **非作用域名**(如 `ds-deepseek-usage`):默认公开,名字全局唯一。registry 实测(2026-08-16)`ds-deepseek-usage` 返回 404,即**当前未被占用**。
- **scoped**(如 `@<你的用户名>/ds-deepseek-usage`):默认私有,发布需公开授权;好处是不占通用名、可组织化。**`@deepseek-ai` scope 需要 deepseek-ai npm 组织成员权限,第三方无法直接发布** —— 第三方只能用自有 scope 或非作用域名。
- 官方生态包全部是 `@deepseek-ai/*` scoped + public;社区插件两种都有(如 `dsh-file-uploads`、`dsh-tool-todo-tree` 非 scoped;`@sugarforever/dsh-mcp-apps` 等 scoped)。

> 来源:npm 官方文档 https://docs.npmjs.com/about-scopes;本机 `npm view` 实测(见上);`dsh-desktop\docs\publishing.md` 第 13–21 行(命名空间三条路);网络检索(npmjs.com 各包页)

### 3.2 发布者侧

```sh
npm login                      # 登录/创建 npm 账号(会打开浏览器)
# 确认包内容(§7 验证清单):
npm pack                       # 或 pnpm pack;检查生成的 .tgz 里都有什么
# 版本号:手动改 package.json 或用 npm version patch/minor/major
npm publish                    # 非作用域名直接公开
# 若用 scoped 包:
npm publish --access public    # 或 package.json 里 publishConfig.access = "public"
```

- npm 发布需要账号与认证:npm 官方文档 https://docs.npmjs.com/cli/v10/commands/npm-publish、https://docs.npmjs.com/creating-and-publishing-an-organization-scoped-package/
- `npm pack` 生成 tarball,内容由 `files` 字段决定:npm 官方文档 https://docs.npmjs.com/cli/v10/commands/npm-pack
- 官方发布文档的对应操作是 `pnpm publish`(monorepo 场景),语义一致。

### 3.3 用户侧安装

**web profile(CLI 浏览器端):**

```sh
dsh plugin --profile web add <包名>        # 例:dsh plugin --profile web add ds-deepseek-usage
dsh --profile web --dump-config            # 可选:先看组合后的树里有没有 "== ds-deepseek-usage" 层
dsh web                                    # 启动
```

**desktop profile(BlueWhale 桌面 GUI):**

```sh
dsh plugin --profile desktop add <包名>
```

之后**重启桌面端**(客户端 bundle 在启动时烘焙进 boot graph,刷新页面不生效;插件集变更同样需重启):

> 来源:`@deepseek-ai\dsh-client-modules\lib\index.js` 第 22–24 行("Package metadata… is cached per name and never expires — plugin-set changes take effect on restart");`ds-deepseek-usage\README.md` 第 58 行

**桌面打包版(便携 exe)的一个已知细节**:`dsh-desktop` 的 launcher 注释说明,打包后的 Electron 内 Loader 解析裸包名时走**应用自身 node_modules**(内部 Node loader 在 Electron V8 里不可用),`$DSH_HOME/profiles/node_modules` 不在解析路径上;launcher 会把用户放进 `profiles/node_modules` 的**真实目录** junction 进应用 node_modules(`linkUserProfilePackages`,当前 ds-deepseek-usage 就是这么被桌面端加载的)。即:对打包版桌面 GUI,插件只装进 `~/.dsh/profiles/desktop/node_modules`(纯 pnpm)未必能被解析 —— 目前可行路径是发布后在两个 profile 里都跑一次 `dsh plugin add`,或沿用"放进 `profiles/node_modules` 真实目录 + patch 挂行"的既有方式。这是 dsh-desktop 项目的打包特性,非官方 DSH 行为,发布文档中应如实告知用户。

> 来源:`dsh-desktop\apps\desktop\src\launcher.js` 第 121–170 行(linkUserProfilePackages 注释);`dsh-desktop\docs\publishing.md` 第 34–41 行

### 3.4 升级/卸载

- 升级:`dsh plugin --profile <name> update <pkg>`(或改依赖后 `dsh plugin --profile <name> install`);对账机制保证"新版本里新增 `dsh.bundle` 声明的包"也会被追加进层列表。
- 卸载:`dsh plugin --profile <name> remove <pkg>` —— 同时移除依赖和对应层。

> 来源:`@deepseek-ai\dsh\lib\plugin-9h8shc4d.js` 第 7–16 行(注释:update 会激活新版本里 gained dsh.bundle 的包)、第 46–78 行;官方发布文档《安装进 profile》("remove 会同时移除依赖和对应的层")

---

## 4. 发布前本地验证清单

在发布前,完全可以在本机用 `dsh plugin` 对**本地路径/tarball**做端到端验证(`dsh plugin` 支持 path/file/link 规格,相对路径锚定到执行目录,§1.2):

1. **语法检查**:`npm run check`(ds-deepseek-usage 已有:`node --check index.js && node --check client.js`)。
2. **`npm pack`**:确认 tarball 内容 = 预期文件(`index.js`、`client.js`、`cordis.patch.yml`、`README.md`、`LICENSE`、`package.json`),不要漏了 `cordis.patch.yml`(对照 `dsh-file-uploads-v1.0.0.tar.gz` 的实测内容:`tar -tzf` 可见 package.json / index.js / client.js / cordis.patch.yml / dsh.plugin.json / README / LICENSE / test/ 等)。
3. **临时 profile 安装测试**(推荐用一次性 profile,不污染 web/desktop):
   ```sh
   dsh plugin --profile test1 add ./ds-deepseek-usage-1.0.0.tgz   # 或 add ./ds-deepseek-usage(目录)
   dsh --profile test1 --dump-config        # 应看到 "# == ds-deepseek-usage" 层与插入的行
   dsh --profile test1                      # 启动验证:host 半区无报错
   ```
4. **客户端验证**:启动 web profile,浏览器确认 `/plugins/ds-deepseek-usage/client.js` 可访问、侧边栏出现 HP/MP 模块;`--dump-config` 之外可用 `dsh --profile web --dump-default-config` 对照默认层。若 `exports["./client"]` 指向的文件缺失,启动即报 `client-modules: client bundle not found`(`@deepseek-ai\dsh-client-modules\lib\index.js` 第 30–44 行)。
5. **卸载验证**:`dsh plugin --profile test1 remove ds-deepseek-usage`,确认依赖与层都被移除。
6. **GitHub 分发(若走此路线)**:`dsh plugin --profile test1 add github:<你>/<repo>`;按 §6.4 处理 `allowBuilds`;验证 `prepare` 脚本在干净环境自包含。
7. **发布后冒烟**:`dsh plugin --profile test2 add ds-deepseek-usage`(从 registry 拉取),确认与本地验证一致。

> 来源:官方发布文档(安装、dump-config、GitHub 三节);`@deepseek-ai\dsh\lib\plugin-9h8shc4d.js`(path 规格支持);本机 `dsh-file-uploads-v1.0.0.tar.gz` tar 实测

---

## 5. 官方插件市场/收录渠道

- **没有官方插件注册表/市场**。官方发布文档只讲 npm / tarball / GitHub 三种分发,没有任何"提交收录"环节。GitHub 上是 `deepseek-ai/DeepSeek-Harness` 仓库(没有 `deepseek-ai/dsh` 仓库;`@deepseek-ai/dsh` 只是 npm 包名)。
- 社区侧存在第三方目录/市场(非官方):`awesome-dsh-plugin`(精选列表)、`dsh-market`(可视化市场插件)、`YELEBAI/dsh-plugin-marketplace`、`AwesomeHou/dsh-plugin-marketplace`、`vlln/plugin-registry`(社区 registry "dsh.so",见 Discussion #1096)等。
- 官方仓库 Discussion 中有公开呼吁官方建插件市场的议题(#1115,"强烈建议尽快建立官方的插件市场"),也有"官方脚手架 `pnpm create dsh-plugin`"的 RFC 讨论(#1629)——均未落地为官方渠道;npm 上已有社区先行实现的 `create-dsh-plugin`(带 ⚠️ 非官方标记)。
- 背景:DeepSeek Harness 公测新闻明确提到"同步开放 npm 插件生态"(https://www.ithome.com/0/989/446.htm);官方主页 https://www.deepseek.com/harness/ 的表述是"开发者预览版:一切皆插件"。
- **结论:目前 DSH 插件的"收录"就是"发布到 npm + 在 README/文档里写清安装方式"**。建议做法:README 里给出安装命令(`dsh plugin --profile web add <pkg>` / `--profile desktop add <pkg>`)、`keywords` 加 `dsh-plugin`/`deepseek-harness`,并考虑在 GitHub topic `dsh-plugin` 下标记仓库以便被发现。

> 来源:官方发布文档(三种形态);https://github.com/deepseek-ai/DeepSeek-Harness (仓库实际地址);网络检索(GitHub topic `dsh-plugin`、Discussion #1115/#1096/#1629、awesome-dsh-plugin、dsh-market、vlln/plugin-registry、ithome 新闻、deepseek.com/harness 等)

---

## 6. 发布形态细节(供文档撰写引用)

### 6.1 双半区插件的完整"可安装"形态(对照 dsh-file-uploads)

`dsh-file-uploads`(社区包,web profile 里正装着)同时声明了 **bundle + client**,是双半区 web 插件发布形态的最佳参照:

```json
{
  "name": "dsh-file-uploads",
  "version": "1.0.0",
  "type": "module",
  "main": "./index.js",
  "exports": { ".": "./index.js", "./client": "./client.js", "./package.json": "./package.json" },
  "files": ["index.js", "client.js", "cordis.patch.yml", "dsh.plugin.json", "README.md", "LICENSE", "..."],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-conversation", "..."] }
  },
  "peerDependencies": { "react": "^18.2.0", "@deepseek-ai/...": "*" },
  "peerDependenciesMeta": { "react": { "optional": true }, ... }
}
```

其 `cordis.patch.yml` 插入插件行(行 `name` = 包名,`inject: [webRuntime]`):

```yaml
- insert:
    - id: dsh-file-uploads
      name: dsh-file-uploads
      inject: [webRuntime]
      config:
        trustedHosts: !!js ctx.webRuntime.trustedHosts
```

其 `client.js` 是工厂形态 bundle:`window.__ModuleLoader__.load({ id: 'dsh-file-uploads', factory: (require) => {...} })`,与 `@deepseek-ai/dsh-client-modules` 描述的"懒加载 CJS 模型"(执行 bundle 只注册 factory,副作用在 materialize 时运行)完全一致。

> 来源:`C:\Users\wuxubaiyang\.dsh\profiles\web\node_modules\dsh-file-uploads\package.json`、`cordis.patch.yml`、`client.js`;`@deepseek-ai\dsh-client-modules\README.md` 第 5–9 行

### 6.2 host 半区插件的行挂载

纯 host 插件(无 UI)与上面的区别是:不需要 `dsh.client`/`exports["./client"]`,只靠 bundle patch 挂行即可。官方最小示例见 §2.1。`ds-deepseek-usage` 的 host 半区(`index.js`,导出 `name`/`inject`/`apply`,用 `ctx.webServer`、`ctx.get('subprocess')`、`ctx.on('llm/stream')`)就是这种形态。

### 6.3 客户端 bundle 的加载细节(写文档时注意)

- 浏览器侧 bundle 由 `window.__ModuleLoader__.load({id, factory})` 注册;factory 里 `require('react')` 解析到页面已注册的模块。
- 客户端行挂载用 `ctx.slots.inject('sidebar.footer.action', ...)` 等槽位注入(`ds-deepseek-usage\client.js` 第 232–240 行就是这么做的)。
- 客户端**模块级** `inject`(client.js 导出里的 `inject: ['slots','timer']`)与 package.json 里 `dsh.client.inject`(bundle 加载顺序边)是两回事,别混用。

> 来源:`@deepseek-ai\dsh-client-modules\README.md` 第 5–11 行;`ds-deepseek-usage\client.js` 第 104、232–240 行

### 6.4 GitHub 安装的构建授权(写文档时注意)

pnpm ≥10 默认拒绝运行 git 依赖的 `prepare` 脚本;首次 `add` 会失败,`dsh` 会提示把 pnpm 打印的确切包键加进该 profile 的 `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-hello-plugin: true
```

然后重跑 `add`。官方文档明确提醒:这是授权"该包代码在安装时于你机器上执行",只对源码可信的包授权,并建议锁 commit(`github:you/repo#<sha>`)。若不想让用户做这个授权,就分发构建产物(npm 或 tarball)。

> 来源:官方发布文档《从 GitHub 安装:构建脚本这道坎》;`@deepseek-ai\dsh\lib\plugin-9h8shc4d.js` 第 124 行

---

## 7. `dsh plugin` 在 Windows 上的注意点

- 需要 pnpm 在 PATH(否则 `dsh plugin` 报 "pnpm not found on PATH — install pnpm to manage profile plugins",exit 127)。profile 的 `package.json` 里 `packageManager` 记录的是 `pnpm@11.13.1`(实测 web profile),供 corepack 使用。
- `dsh plugin` 用 `spawnSync("pnpm", ..., shell: true)` 在 Windows 上执行(`@deepseek-ai\dsh\lib\plugin-9h8shc4d.js` 第 108–112 行)。

---

## 8. 参考现成资料

- `dsh-desktop\docs\publishing.md` —— 本工作区此前对"发布 DSH 插件"的调研结论与操作手册(npm login → 一键改名发布;命名空间三条路),可交叉印证本文。
- `dsh-desktop\docs\architecture.md` —— dsh-desktop 架构;含对 DSH 0.1.0-rc.6 源码的调研结论(bundle 解析、fallback 等)。
- `dsh-desktop\README.zh.md` —— 桌面 GUI 的 profile 组合、更新、打包说明。

> 以上均为本工作区文件,非官方来源;本文所有结论均以 §9 的一手来源为准。

---

## 9. ds-deepseek-usage 距"可直接发布"还差什么(逐项)

现状(`jtech_plugin\ds-deepseek-usage\package.json`,目录含 `index.js`、`client.js`、`package.json`、`README.md`):

```json
{
  "name": "ds-deepseek-usage",
  "version": "1.0.0",
  "description": "DeepSeek account usage monitor (HP/MP) ...",
  "license": "MIT",
  "type": "module",
  "main": "./index.js",
  "exports": { ".": "./index.js", "./client": "./client.js", "./package.json": "./package.json" },
  "files": ["index.js", "client.js"],
  "dsh": { "client": { "platform": "web", "inject": [] } },
  "engines": { "node": ">=22" },
  "peerDependencies": { "react": "^18.2.0" },
  "peerDependenciesMeta": { "react": { "optional": true } }
}
```

### 必须改(否则无法"一键安装")

| # | 缺口 | 说明与依据 |
| --- | --- | --- |
| 1 | **缺少 `dsh.bundle.patch` 声明** | 没有它,`dsh plugin add ds-deepseek-usage` 只把它当普通依赖(CLI 打印警告、不激活任何层),插件不会加载。依据:官方发布文档 §2.1-1、`plugin-9h8shc4d.js` 第 57 行。**修法**:加 `"bundle": { "patch": "./cordis.patch.yml" }` 进 `dsh` 键 |
| 2 | **缺少 `cordis.patch.yml`** | bundle patch 要引用的文件不存在。**修法**:新建,内容就是用户现在手动往 profile 里贴的那段(§6.1 形态,行 `name: ds-deepseek-usage`;可参考 dsh-file-uploads 加 `inject: [webRuntime]`,或保持与现状一致的裸行 `{id, name}` —— 现有 `~/.dsh/profiles/web/cordis.patch.yml` 就是 `- insert: [{id: ds-deepseek-usage, name: ds-deepseek-usage}]` 且工作正常) |
| 3 | **`files` 缺 `cordis.patch.yml`** | 不列进去,发布后 patch 文件不在包里。**修法**:`files` 改为 `["index.js", "client.js", "cordis.patch.yml", "README.md", "LICENSE"]`(LICENSE 如不生成文件可略) |

### 建议改(发布质量,非必需)

| # | 项 | 说明 |
| --- | --- | --- |
| 4 | `keywords` | 加 `["deepseek-harness", "dsh", "dsh-plugin", "cordis", "deepseek", "usage"]` 便于被发现(对照 dsh-file-uploads) |
| 5 | `repository` / `homepage` / `bugs` / `author` | 指向 `jtech_plugin` 仓库与作者信息(官方包与 dsh-file-uploads 都有) |
| 6 | `LICENSE` 文件 | `license: "MIT"` 字段已有;建议随包放一个 `LICENSE` 文本(dsh-file-uploads 的 tar 里有) |
| 7 | README 补安装命令 | 现有 README 的"安装"节还是手动拷贝 + patch 方式;发布后应改为 `dsh plugin --profile web add ds-deepseek-usage`(和 desktop 变体),并说明重启生效 |

### 明确不需要改(已核实)

| 项 | 结论 | 依据 |
| --- | --- | --- |
| `name` 是否冲突 | **registry 实测(2026-08-16)`ds-deepseek-usage` 返回 404 = 当前可用**;非作用域名默认公开,无需 `publishConfig.access`。若想用 scoped,才需要 `--access public` | 本机 `npm view ds-deepseek-usage` 实测;npm scopes 文档 |
| `dsh.client.inject: []` 是否影响发现 | **不影响**。发现只看 `platform === "web"` + `exports["./client"]`;`inject` 只是 bundle 加载顺序边(空数组合法,校验仅要求"字符串数组") | `@deepseek-ai\dsh-client-modules\lib\index.js` 第 61–73、251 行 |
| `exports["./client"]` 形态 | `"./client": "./client.js"` 是合法字符串形式;`client.js` 是手写 factory bundle(`window.__ModuleLoader__.load`),与运行时模型一致,无需构建步骤 | `@deepseek-ai\dsh-client-modules\lib\index.js` 第 74–85 行;`ds-deepseek-usage\client.js` 第 4–6 行 |
| `main` / `exports["."]` | 已有,host 半区可被 loader 正常 import | 官方发布文档最小示例 |
| `type: "module"`、`engines.node >= 22`、`peerDependencies`(react, optional) | 与生态一致;`autoInstallPeers: false` 下 react 从 dsh 安装闭包/fallback 解析,可选 peer 不会阻塞安装 | §2.2 |
| `types`/TS 产物 | 纯 JS 插件不需要 | — |
| `dsh.plugin.json` | 可选展示元数据,本地一手来源无消费者;可加可不加 | §2.2 末行 |

### 改完之后的预期行为

`dsh plugin --profile web add ds-deepseek-usage` 之后:

- `dsh.profile.bundles` 自动追加 `"ds-deepseek-usage"`(对账机制);
- boot 时应用其 `cordis.patch.yml` → 插件行插入 → host 半区加载(注册 `/api/ds-usage`)、client 半区被 dsh-client-modules 发现并以 `/plugins/ds-deepseek-usage/client.js` 供给浏览器;
- 用户不再需要手改任何 `cordis.patch.yml`;升级/卸载由 `dsh plugin` 管理。

> 依据:§1.2、§2.1、§2.3 全部来源。

---

## 10. 参考资料索引(一手来源)

**官方文档(在线)**
- 官方发布文档(中文):https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/publish.zh.md
- 官方发布文档(英文):https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/publish.md
- 官方仓库:https://github.com/deepseek-ai/DeepSeek-Harness
- 官方开发教程其它篇:https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/index.md 、`basic/config.md`(插件配置)、`basic/tool.md`(工具)、`docs/user/develop/framework/service.md`(服务)、`docs/cookbook/adding-a-package.md`(monorepo 新增包)
- 官方 CLI 参考:https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/apps/cli/reference/README.md;官方主页:https://www.deepseek.com/harness/
- npm 官方:https://docs.npmjs.com/about-scopes 、https://docs.npmjs.com/cli/v10/commands/npm-publish 、https://docs.npmjs.com/creating-and-publishing-an-organization-scoped-package/ 、https://docs.npmjs.com/cli/v10/commands/npm-pack
- 背景新闻:https://www.ithome.com/0/989/446.htm(公测"同步开放 npm 插件生态")、https://www.sitepoint.com/deepseek-harness-developer-preview/

**本机安装的一手源码(路径前缀 `C:\Users\wuxubaiyang\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\`)**
- `@deepseek-ai\dsh\lib\bin.js`(dsh CLI 语法,`plugin` 子命令定义)
- `@deepseek-ai\dsh\lib\plugin-9h8shc4d.js`(`dsh plugin` = pnpm 转发 + bundles 对账)
- `@deepseek-ai\dsh\README.md` / `README.zh.md`(profile/bundle 机制)
- `@deepseek-ai\dsh-app-boot\lib\index.js`(initProfile / resolveBundleDir / loadProfile / healProfilesModuleFallback / patch 语义)
- `@deepseek-ai\dsh-client-modules\README.md` + `lib\index.js`(`dsh.client` 清单、`exports["./client"]`、`/plugins` 路由、启动时烘焙)
- `@deepseek-ai\dsh-client-ui-settings-plugins\package.json`(官方插件包字段形态)
- `@deepseek-ai\dsh-host-plugin-inventory\README.md`、`@deepseek-ai\dsh-client-ui-settings-plugin-inventory\README.md`(Settings"插件"页 = 只读 loader 快照)
- `@deepseek-ai\dsh-web-app\package.json`(官方 bundle 的 `dsh.bundle.patch` 形态)

**本机运行时/仓库文件**
- `C:\Users\wuxubaiyang\.dsh\profiles\web\package.json`、`cordis.patch.yml`、`node_modules\dsh-file-uploads\*`(已装社区双半区插件)
- `C:\Users\wuxubaiyang\.dsh\profiles\web\vendor\dsh-file-uploads-v1.0.0.tar.gz`(tarball 分发形态实测)
- `C:\Users\wuxubaiyang\Documents\workspace\dsh-desktop\apps\desktop\src\launcher.js`(桌面 GUI 插件解析/链接机制)
- `C:\Users\wuxubaiyang\Documents\workspace\jtech_plugin\ds-deepseek-usage\package.json` 等(目标插件现状)
