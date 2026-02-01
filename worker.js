import { Hono } from 'hono'

const CONFIG = {
  UPSTREAM_URL: 'https://emos.best',
  PROXY_ID: 'eO9M28W9Js',
  PROXY_NAME: 'you',
  BASE_PATH: '/emby',

  // 静态资源正则
  STATIC_REGEX: /(\.(jpg|jpeg|png|gif|css|js|ico|svg|webp|woff|woff2)|(\/Images\/(Primary|Backdrop|Logo|Thumb|Banner|Art))|(\/emby\/Items\/.*\/Images\/))/i,
  // 视频流正则
  VIDEO_REGEX: /(\/Videos\/|\/Items\/.*\/Download|\/Items\/.*\/Stream|\.m3u8|\.ts)/i,
  // API 缓存正则
  API_CACHE_REGEX: /(\/Items\/Resume|\/Users\/.*\/Items\/)/i,

  API_TIMEOUT: 2500
}

const app = new Hono()

// 超时处理函数
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

  // 1. 路径自动补全
  let path = url.pathname
  if (!path.startsWith(CONFIG.BASE_PATH) && path !== '/') {
    path = CONFIG.BASE_PATH + path
  }

  const targetUrl = new URL(path + url.search, CONFIG.UPSTREAM_URL)
  const proxyHeaders = new Headers(req.headers)

  // 2. 头部修复与身份透传
  proxyHeaders.set('Host', targetUrl.hostname)
  proxyHeaders.set('Referer', targetUrl.origin)
  proxyHeaders.set('Origin', targetUrl.origin)
  proxyHeaders.set('EMOS-PROXY-ID', CONFIG.PROXY_ID)
  proxyHeaders.set('EMOS-PROXY-NAME', CONFIG.PROXY_NAME)

  // 3. IP 透传
  const clientIp = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')
  if (clientIp) {
    proxyHeaders.set('X-Forwarded-For', clientIp)
    proxyHeaders.set('X-Real-IP', clientIp)
  }

  // 清除冗余 Cloudflare 头部防止循环
  proxyHeaders.delete('cf-ray')
  proxyHeaders.delete('cf-visitor')
  proxyHeaders.delete('cf-tap-token')

  const isVideo = CONFIG.VIDEO_REGEX.test(path)
  const isStatic = CONFIG.STATIC_REGEX.test(path)
  const isApiCacheable = CONFIG.API_CACHE_REGEX.test(path)
  const isWebSocket = req.headers.get('Upgrade') === 'websocket'

  // 4. 传输策略优化
  const cfConfig = {
    cacheEverything: isVideo ? false : (isStatic || isApiCacheable),
    cacheTtl: isStatic ? 31536000 : 0,
    polish: isStatic ? 'lossy' : 'off',
    minify: 'off',
    mirage: false,
    scrapeShield: false,
  }

  const fetchOptions = {
    method: req.method,
    headers: proxyHeaders,
    // 关键优化：禁止在 Worker 中 await body，直接使用 ReadableStream 转发
    body: (req.method === 'GET' || req.method === 'HEAD') ? null : req.body,
    redirect: 'manual',
    cf: cfConfig
  }

  try {
    let response;
    // 视频、WebSocket、POST 使用持久连接
    if (isVideo || isWebSocket || req.method === 'POST') {
      response = await fetch(targetUrl.toString(), fetchOptions)
    } else {
      try {
        response = await fetchWithTimeout(targetUrl.toString(), fetchOptions, CONFIG.API_TIMEOUT)
      } catch (err) {
        // 超时回退
        response = await fetch(targetUrl.toString(), fetchOptions)
      }
    }

    const resHeaders = new Headers(response.headers)
    
    // 5. 跨域与安全头清理
    resHeaders.set('access-control-allow-origin', '*')
    resHeaders.delete('content-security-policy')
    resHeaders.delete('X-Content-Type-Options')

    // 6. 206 Partial Content 深度优化
    if (response.status === 206) {
      // 显式确保关键头部存在，这对安卓端拖动进度条至关重要
      resHeaders.set('Accept-Ranges', 'bytes')
      const contentRange = response.headers.get('content-range')
      if (contentRange) resHeaders.set('Content-Range', contentRange)
      
      return new Response(response.body, {
        status: 206,
        headers: resHeaders
      })
    }

    // 处理静态资源缓存
    if (isStatic && (response.status === 200 || response.status === 304)) {
      resHeaders.set('Cache-Control', 'public, max-age=31536000, immutable')
    }

    // 处理 WebSocket
    if (response.status === 101) {
      return new Response(null, { status: 101, webSocket: response.webSocket, headers: resHeaders })
    }

    // 重定向修正
    if ([301, 302, 307, 308].includes(response.status)) {
      const location = resHeaders.get('location')
      if (location) {
        const locUrl = new URL(location, targetUrl.href)
        if (locUrl.hostname === targetUrl.hostname) {
          resHeaders.set('Location', locUrl.pathname + locUrl.search)
        }
      }
      return new Response(null, { status: response.status, headers: resHeaders })
    }

    // 默认流式返回
    return new Response(response.body, {
      status: response.status,
      headers: resHeaders
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: `Proxy Error: ${error.message}` }), { 
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    })
  }
})

export default app