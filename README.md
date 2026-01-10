# CF-Emby-Proxy

基于 Cloudflare Workers 的 Emby 媒体服务器代理加速服务，通过智能缓存策略提升访问速度。

## 功能特性

- **静态资源强缓存**：图片、CSS、JS 等静态资源缓存 1 年
- **API 微缓存**：慢速 API 接口缓存 10 秒，显著改善页面导航体验
- **视频流直连**：视频流不缓存，直接透传，确保最佳播放效果
- **智能超时重试**：针对不同请求类型采用不同的超时策略
- **WebSocket 支持**：完整支持 Emby 的实时功能

## 缓存策略

| 请求类型 | 策略 | 缓存时间 |
|---------|------|---------|
| 静态资源（图片/CSS/JS） | Cloudflare 缓存 | 1 年 |
| API 接口（Resume/用户数据） | 微缓存 | 10 秒 |
| 视频流 | 直连透传 | 不缓存 |
| WebSocket | 直连透传 | 不缓存 |

## 部署教程

### 前置要求

- Node.js 18 或更高版本
- Cloudflare 账号（免费版即可）
- Wrangler CLI 工具

### 第一步：安装 Wrangler CLI

```bash
npm install -g wrangler
```

### 第二步：登录 Cloudflare

```bash
wrangler login
```

执行后会打开浏览器进行授权登录。

### 第三步：克隆或下载本项目

```bash
git clone https://github.com/cnm-microsoft/CF-Emby-Proxy.git
cd CF-Emby-Proxy
```

### 第四步：安装依赖

```bash
npm install
```

### 第五步：配置项目

1. **修改 `wrangler.json`**，设置 Worker 名称：

```json
{
  "name": "your-worker-name",
  "main": "worker.js",
  "compatibility_date": "2025-12-28",
  "compatibility_flags": ["nodejs_compat"]
}
```

2. **修改 `worker.js`**，设置你的 Emby 服务器地址：

```javascript
const CONFIG = {
  UPSTREAM_URL: 'https://your-emby-server.com', // 替换为你的 Emby 服务器地址
  // ... 其他配置
}
```

### 第六步：部署到 Cloudflare

```bash
npx wrangler deploy
```

部署成功后会显示类似以下信息：

```
✨ Successfully published your Worker to
  https://your-worker-name.your-subdomain.workers.dev
```

### 第七步：配置自定义域名（可选）

如果需要使用自定义域名：

1. 在 Cloudflare 控制台中添加你的域名
2. 进入 Workers & Pages 页面
3. 点击你的 Worker -> 设置 -> 触发器 -> 添加自定义域名
4. 输入域名（如 `emby.yourdomain.com`）

## 配置说明

编辑 `worker.js` 中的 `CONFIG` 对象来自定义配置：

| 配置项 | 说明 | 默认值 |
|-------|------|--------|
| `UPSTREAM_URL` | 你的 Emby 服务器地址 | - |
| `STATIC_REGEX` | 静态资源匹配正则 | 匹配图片/CSS/JS 等常见格式 |
| `VIDEO_REGEX` | 视频流匹配正则 | 匹配 `/Videos/` 等路径 |
| `API_CACHE_REGEX` | 可缓存 API 匹配正则 | 匹配 Resume 等接口 |
| `API_TIMEOUT` | API 请求超时时间（毫秒） | 2500 |

## 技术架构

- 基于 [Hono](https://hono.dev/) 构建 - 轻量级 Web 框架
- 利用 Cloudflare 边缘网络加速
- 支持 HTTP 和 WebSocket 连接
- 自动清理请求头，确保代理透明性

## 常见问题

**Q: 视频播放卡顿怎么办？**

A: 视频流默认直连透传，如果卡顿可能是源站问题。可以尝试调整 `API_TIMEOUT` 参数。

**Q: 为什么某些接口返回的数据不是最新的？**

A: 部分慢速 API 启用了 10 秒微缓存来提升性能。如果需要实时数据，可以修改 `API_CACHE_REGEX` 配置。

**Q: 支持哪些 Emby 版本？**

A: 理论上支持所有版本的 Emby，因为代理只是转发请求。

## 许可证

ISC
