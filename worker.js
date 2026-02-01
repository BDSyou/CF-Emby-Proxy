import { Hono } from 'hono'

const CONFIG = {
  UPSTREAM_URL: 'https://emos.best', 
  PROXY_ID: 'eO9M28W9Js', // 替换为你的用户ID
  PROXY_NAME: 'you',       // 替换为你的称号
  
  // 基础反代路径
  BASE_PATH: '/emby',
  
  // 静态资源匹配：增加 /emby/Items/*/Images/* 的显式支持
  STATIC_REGEX: /(\.(jpg|jpeg|png|gif|css|js|ico|svg|webp|woff|woff2)|(\/Images\/(Primary|Backdrop|Logo|Thumb|Banner|Art))|(\/emby\/Items\/.*\/Images\/))/i,
  
  // 视频流 (直连，不缓存，不重试)
  VIDEO_REGEX: /(\/Videos\/|\/Items\/.*\/Download|\/Items\/.*\/Stream)/i,
  
  // 慢接口微缓存 (解决 Resume 1.5s 的问题)
  API_CACHE_REGEX: /(\/Items\/Resume|\/Users\/.*\/Items\/)/i,
  
  // API超时设置
  API_TIMEOUT: 2500
}

const app = new Hono()

// 带超时的 fetch 封装
async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

app.all('*', async (c) => {
  const req = c.req.raw
  const url = new URL(req.url)
  
  // --- 1. 路径自动补全 ---
  // 如果客户端请求路径不带 /emby，则在回源时自动补上
  let path = url.pathname
  if (!path.startsWith(CONFIG.BASE_PATH) && path !== '/') {
    path = CONFIG.BASE_PATH + path
  }
  
  const targetUrl = new URL(path + url.search, CONFIG.UPSTREAM_URL)
  
  // --- 2. 头部处理 (含 UA 透传与身份识别) ---
  const proxyHeaders = new Headers(req.headers)
  
  // 显式透传 User-Agent，解决 /test 接口 ua 为 null 的问题
  const originalUA = req.headers.get('User-Agent')
  if (originalUA) {
    proxyHeaders.set('User-Agent', originalUA)
  }

  proxyHeaders.set('Host', targetUrl.hostname)
  proxyHeaders.set('Referer', targetUrl.origin)
  proxyHeaders.set('Origin', targetUrl.origin)
  proxyHeaders.set('EMOS-PROXY-ID', CONFIG.PROXY_ID)
  proxyHeaders.set('EMOS-PROXY-NAME', CONFIG.PROXY_NAME)

  // 必须传递客户端真实 IP
  const clientIp = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')
  if (clientIp) {
    proxyHeaders.set('X-Forwarded-For', clientIp)
  }

  // 剔除 Cloudflare 干扰头
  proxyHeaders.delete('cf-connecting-ip')
  proxyHeaders.delete('cf-ray')
  proxyHeaders.delete('cf-visitor')

  // 缓冲非流式请求体 (POST 等)
  let reqBody = req.body
  if (!['GET', 'HEAD'].includes(req.method) && !url.pathname.includes('/Upload')) {
    reqBody = await req.arrayBuffer()
    proxyHeaders.delete('content-length')
  }

  // --- 3. 类型判别 ---
  const isStatic = CONFIG.STATIC_REGEX.test(path)
  const isVideo = CONFIG.VIDEO_REGEX.test(path)
  const isApiCacheable = CONFIG.API_CACHE_REGEX.test(path)
  const isWebSocket = req.headers.get('Upgrade') === 'websocket'

  // --- 4. Cloudflare 边缘策略 ---
  const cfConfig = {
    cacheEverything: isStatic || isApiCacheable,
    cacheTtl: isStatic ? 31536000 : (isApiCacheable ? 10 : 0),
    cacheTtlByStatus: isApiCacheable ? { "200-299": 10 } : null,
    polish: isStatic ? 'lossy' : 'off',
    minify: { javascript: isStatic, css: isStatic, html: isStatic },
    mirage: false,
    scrapeShield: false,
    apps: false,
  }

  const fetchOptions = {
    method: req.method,
    headers: proxyHeaders,
    body: reqBody,
    redirect: 'manual',
    cf: cfConfig
  }

  try {
    let response;

    // 视频流 & WebSocket 直连 (不设超时)
    if (isVideo || isWebSocket || req.method === 'POST') {
      response = await fetch(targetUrl.toString(), fetchOptions)
    } else {
      // API & 图片启用超时重试
      try {
        response = await fetchWithTimeout(targetUrl.toString(), fetchOptions, CONFIG.API_TIMEOUT)
      } catch (err) {
        response = await fetch(targetUrl.toString(), fetchOptions)
      }
    }

    // --- 5. 响应处理 ---
    // 直接继承所有头部，确保 Content-Type, Content-Range (206) 正确透传给安卓
    const resHeaders = new Headers(response.headers)
    resHeaders.delete('content-security-policy')
    resHeaders.delete('clear-site-data')
    resHeaders.set('access-control-allow-origin', '*')

    // 强制关闭视频连接防止卡死
    if (isVideo) {
        resHeaders.set('Connection', 'close')
    }
    
    // 强制静态图片缓存生效
    if (isStatic && (response.status === 200 || response.status === 304)) {
        resHeaders.set('Cache-Control', 'public, max-age=31536000, immutable')
        resHeaders.delete('Pragma')
        resHeaders.delete('Expires')
    }

    // 处理 WebSocket 握手
    if (response.status === 101) {
      return new Response(null, { status: 101, webSocket: response.webSocket, headers: resHeaders })
    }

    // 重定向修正
    if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = resHeaders.get('location')
        if (location) {
             const locUrl = new URL(location, targetUrl.href)
             if (locUrl.hostname === targetUrl.hostname) {
                 resHeaders.set('Location', locUrl.pathname + locUrl.search)
             }
        }
        return new Response(null, { status: response.status, headers: resHeaders })
    }

    // 最终返回：透传原样状态码 (如 206) 和所有经过处理的 Header
    return new Response(response.body, {
      status: response.status,
      headers: resHeaders
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: `Proxy Error: ${error.message}` }), { status: 502 })
  }
})

export default app