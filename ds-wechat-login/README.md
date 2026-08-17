# ds-wechat-login

**DeepSeek 开放平台微信扫码登录 CLI** —— 终端里扫码换 `userToken`,纯接口实现(无需浏览器/CDP/任何依赖)。

## 安装

```sh
# 直接运行(无需安装)
npx ds-wechat-login --balance

# 或全局安装
npm i -g ds-wechat-login
ds-wechat-login --balance
```

## 用法

```sh
ds-wechat-login [选项]

选项:
  --qr <open|browser|url>   二维码展示方式(默认 open,自动用系统看图工具打开;
                            url 只打印链接,适合无图形环境)
  --balance                 登录后查询并显示账户余额
  --token-file <path>       把 userToken 写入指定文件
  --json                    以 JSON 输出结果
  -h, --help                显示帮助
```

示例:

```sh
# 扫码登录并显示余额
ds-wechat-login --balance

# 保存 token 供脚本使用
ds-wechat-login --token-file ~/.deepseek-token

# 无图形环境:只打印二维码链接,用手机浏览器打开后扫码
ds-wechat-login --qr url
```

## 工作原理(纯接口,已实机验证)

```
1. GET open.weixin.qq.com/connect/qrconnect?...&f=xml   → uuid
2. 二维码图  open.weixin.qq.com/connect/qrcode/<uuid>    → 展示给用户扫描
3. 轮询 long.open.weixin.qq.com/connect/l/qrconnect?uuid=
   (wx_errcode: 408 等待 / 405 已扫 / 200+wx_code 确认)
4. GET platform.deepseek.com/auth-api/v0/users/oauth/wechat/callback?code=
   → 307 Location 里的 nonce
5. POST /auth-api/v0/users/oauth/get_token {nonce, provider:"WECHAT"}
   → biz_data.token = userToken
```

得到的 `userToken` 可用于 `Authorization: Bearer <token>` 调用 DeepSeek 开放平台 API(如 `GET /api/v0/users/get_user_summary`)。

## 与 ds-deepseek-usage 插件配合

插件从 token 文件读取登录态(每 10 秒自动重载,无需重启):

```sh
ds-wechat-login --balance --token-file ~/.dsh/ds-deepseek-usage.token
```

## 许可

MIT
