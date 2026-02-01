import { Hono } from 'hono'

const CONFIG = {
  UPSTREAM_URL: 'https://emos.best', 
  // --- 身份标识 ---
  PROXY_ID: 'eO9M28W9Js', 
  PROXY_NAME: '游',      
  
  // --- 路径匹配 ---
  // 包含标准的静态后缀及 Emby 特有的图片路径
  STATIC_REGEX: /(\.(jpg|jpeg|png|gif|css|js|ico|svg|webp|woff|woff2)|(\/Images\/(Primary|Backdrop|Logo|Thumb|Banner|Art))|(\/emby\/Items\/.*\/Images\/))/i,
  // 视频流路径（直连，不缓存）
  VIDEO_REGEX: /(\/Videos\/|\/Items\/.*\/Download|\/Items\/.*\/Stream)/i,
  // API 微缓存路径（优化 Resume 接口）
  API_CACHE_REGEX: /(\/Items\/Resume|\/Users\/.*\/Items\/)/i,
  
  API_TIMEOUT: 2500
}

const app = new Hono()

/**
 * 带有超时控制的请求函数
 */
async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

app.all('*', async (c) => {
  const req = c.req.raw
  const url = new URL(req.url)
  const cache = caches.default
  const cacheKey = new Request(url.toString(), req)

  // 1. 基础路由与健康检查
  if (url.pathname === '/' || url.pathname === '/index.html') return c.html(STATUS_PAGE_HTML)
  if (url.pathname === '/ping') return new Response('pong', { status: 200 })

  // 2. 构造回源请求
  const targetUrl = new URL('/emby' + url.pathname + url.search, CONFIG.UPSTREAM_URL)
  const proxyHeaders = new Headers(req.headers)
  
  // --- 核心配置实现 ---
  proxyHeaders.set('Host', targetUrl.hostname)
  proxyHeaders.set('EMOS-PROXY-ID', CONFIG.PROXY_ID)
  proxyHeaders.set('EMOS-PROXY-NAME', CONFIG.PROXY_NAME)

  // 传递 X-FORWARDED-FOR
  const clientIp = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')
  if (clientIp) {
    proxyHeaders.set('X-Forwarded-For', clientIp)
  }

  // 清理多余头部，优化传输
  proxyHeaders.delete('cf-connecting-ip')
  proxyHeaders.delete('cf-ray')
  proxyHeaders.delete('cf-visitor')
  proxyHeaders.set('Accept-Encoding', 'gzip, deflate, br')

  const isStatic = CONFIG.STATIC_REGEX.test(url.pathname)
  const isVideo = CONFIG.VIDEO_REGEX.test(url.pathname)
  const isApiCacheable = CONFIG.API_CACHE_REGEX.test(url.pathname)
  const isWebSocket = req.headers.get('Upgrade') === 'websocket'

  // 3. 静态资源深度缓存策略 (Cache API)
  if (isStatic && req.method === 'GET') {
    let cachedResponse = await cache.match(cacheKey)
    if (cachedResponse) {
      // 增加缓存命中标识，方便调试
      const newHeaders = new Headers(cachedResponse.headers)
      newHeaders.set('X-Proxy-Cache', 'HIT')
      return new Response(cachedResponse.body, { headers: newHeaders })
    }
  }

  // 4. Cloudflare 边缘优化参数
  const cfConfig = {
    cacheEverything: isStatic || isApiCacheable,
    cacheTtl: isStatic ? 31536000 : (isApiCacheable ? 10 : 0),
    polish: isStatic ? 'lossy' : 'off',
    minify: { javascript: isStatic, css: isStatic, html: isStatic },
    mirage: isStatic, 
    jumpStart: true // 开启 TCP 优化
  }

  const fetchOptions = {
    method: req.method,
    headers: proxyHeaders,
    body: (req.method !== 'GET' && req.method !== 'HEAD') ? await req.arrayBuffer() : null,
    redirect: 'manual',
    cf: cfConfig
  }

  try {
    let response;
    // 5. 视频流 & WebSocket 直连
    if (isVideo || isWebSocket || req.method === 'POST') {
      response = await fetch(targetUrl.toString(), fetchOptions)
    } else {
      // API 和图片带超时重试机制
      try {
        response = await fetchWithTimeout(targetUrl.toString(), fetchOptions, CONFIG.API_TIMEOUT)
      } catch {
        response = await fetch(targetUrl.toString(), fetchOptions)
      }
    }

    // 6. 响应头二次处理
    const resHeaders = new Headers(response.headers)
    resHeaders.set('access-control-allow-origin', '*')
    resHeaders.delete('content-security-policy')

    // 针对视频流（206 状态码通常在此处）
    if (isVideo) {
      resHeaders.set('Connection', 'close') 
    }

    // 7. 强制静态资源缓存入库
    if (isStatic && response.status === 200 && req.method === 'GET') {
      resHeaders.set('Cache-Control', 'public, max-age=31536000, immutable')
      const cacheResponse = new Response(response.body, { ...response, headers: resHeaders })
      // 使用 waitUntil 确保缓存写入不阻塞当前响应
      c.executionCtx.waitUntil(cache.put(cacheKey, cacheResponse.clone()))
      return cacheResponse
    }

    // 8. 处理重定向地址
    if ([301, 302, 307, 308].includes(response.status)) {
      const location = resHeaders.get('location')
      if (location) {
        const locUrl = new URL(location, targetUrl.href)
        if (locUrl.hostname === targetUrl.hostname) {
          resHeaders.set('Location', locUrl.pathname + locUrl.search)
        }
      }
    }

    // 返回响应（自动支持 206 Partial Content）
    return new Response(response.body, {
      status: response.status,
      headers: resHeaders
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 502 })
  }
})

export default app

// --- 延迟检测页面 (保持你的样式) ---
const STATUS_PAGE_HTML = `...` // 此处由于篇幅限制省略，请沿用你原始代码中的 HTML 字符串