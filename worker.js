import { Hono } from 'hono'

const CONFIG = {
  UPSTREAM_URL: 'https://emos.best', 
  PROXY_ID: 'eO9M28W9Js',
  PROXY_NAME: 'you',
  // 优化图片缓存正则，安卓端海报墙加载频繁，建议覆盖 /emby/Items/*/Images/*
  STATIC_REGEX: /(\.(jpg|jpeg|png|gif|css|js|ico|svg|webp|woff|woff2)|(\/Images\/(Primary|Backdrop|Logo|Thumb|Banner|Art))|(\/emby\/Items\/.*\/Images\/))/i,
  VIDEO_REGEX: /(\/Videos\/|\/Items\/.*\/Download|\/Items\/.*\/Stream)/i,
  API_CACHE_REGEX: /(\/Items\/Resume|\/Users\/.*\/Items\/)/i,
  API_TIMEOUT: 2500
}

const app = new Hono()

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
  const targetUrl = new URL(url.pathname + url.search, CONFIG.UPSTREAM_URL)
  
  const proxyHeaders = new Headers(req.headers)
  
  // --- 必填身份头部 ---
  proxyHeaders.set('Host', targetUrl.hostname)
  proxyHeaders.set('Referer', targetUrl.origin)
  proxyHeaders.set('Origin', targetUrl.origin)
  proxyHeaders.set('EMOS-PROXY-ID', CONFIG.PROXY_ID)
  proxyHeaders.set('EMOS-PROXY-NAME', CONFIG.PROXY_NAME)

  // --- 安卓端必须传递 X-FORWARDED-FOR 否则可能被源站风控 ---
  const clientIp = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')
  if (clientIp) {
    proxyHeaders.set('X-Forwarded-For', clientIp)
  }

  // 剔除杂项
  proxyHeaders.delete('cf-connecting-ip')
  proxyHeaders.delete('cf-ray')
  proxyHeaders.delete('cf-visitor')

  let reqBody = req.body
  if (!['GET', 'HEAD'].includes(req.method) && !url.pathname.includes('/Upload')) {
    reqBody = await req.arrayBuffer()
    proxyHeaders.delete('content-length')
  }

  const isStatic = CONFIG.STATIC_REGEX.test(url.pathname)
  const isVideo = CONFIG.VIDEO_REGEX.test(url.pathname)
  const isApiCacheable = CONFIG.API_CACHE_REGEX.test(url.pathname)
  const isWebSocket = req.headers.get('Upgrade') === 'websocket'

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
    // 视频和 Socket 直连
    if (isVideo || isWebSocket || req.method === 'POST') {
      response = await fetch(targetUrl.toString(), fetchOptions)
    } else {
      try {
        response = await fetchWithTimeout(targetUrl.toString(), fetchOptions, CONFIG.API_TIMEOUT)
      } catch (err) {
        response = await fetch(targetUrl.toString(), fetchOptions)
      }
    }

    // --- 响应处理 ---
    // 直接继承所有头部，确保 Content-Type 和 Content-Range 完整透传给安卓
    const resHeaders = new Headers(response.headers)
    
    resHeaders.delete('content-security-policy')
    resHeaders.delete('clear-site-data')
    resHeaders.set('access-control-allow-origin', '*')

    // 针对安卓端视频流关闭保持连接，防止 Socket 占用导致播放卡死
    if (isVideo) {
        resHeaders.set('Connection', 'close')
    }

    // 静态资源强行命中缓存
    if (isStatic && (response.status === 200 || response.status === 304)) {
        resHeaders.set('Cache-Control', 'public, max-age=31536000, immutable')
        resHeaders.delete('Pragma')
    }

    // 核心处理：101, 206, 302 等状态码必须由 response.status 原样返回
    if (response.status === 101) {
      return new Response(null, { status: 101, webSocket: response.webSocket, headers: resHeaders })
    }

    // 修正重定向
    if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = resHeaders.get('location')
        if (location) {
             const locUrl = new URL(location, targetUrl.href)
             if (locUrl.hostname === targetUrl.hostname) {
                 resHeaders.set('Location', locUrl.pathname + locUrl.search)
             }
        }
    }

    // 返回给客户端
    return new Response(response.body, {
      status: response.status,
      headers: resHeaders
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: `Proxy Error: ${error.message}` }), { status: 502 })
  }
})

export default app