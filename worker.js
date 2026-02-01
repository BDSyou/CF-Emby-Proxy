import { Hono } from 'hono'

const CONFIG = {
  UPSTREAM_URL: 'https://emos.best', 
  PROXY_ID: 'eO9M28W9Js', 
  PROXY_NAME: 'you',       
  BASE_PATH: '/emby',
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
  
  let path = url.pathname
  if (!path.startsWith(CONFIG.BASE_PATH) && path !== '/') {
    path = CONFIG.BASE_PATH + path
  }
  
  const targetUrl = new URL(path + url.search, CONFIG.UPSTREAM_URL)
  const proxyHeaders = new Headers(req.headers)
  
  // 保持 UA 和 身份标识
  const originalUA = req.headers.get('User-Agent')
  if (originalUA) proxyHeaders.set('User-Agent', originalUA)

  proxyHeaders.set('Host', targetUrl.hostname)
  proxyHeaders.set('Referer', targetUrl.origin)
  proxyHeaders.set('Origin', targetUrl.origin)
  proxyHeaders.set('EMOS-PROXY-ID', CONFIG.PROXY_ID)
  proxyHeaders.set('EMOS-PROXY-NAME', CONFIG.PROXY_NAME)

  const clientIp = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')
  if (clientIp) proxyHeaders.set('X-Forwarded-For', clientIp)

  const isStatic = CONFIG.STATIC_REGEX.test(path)
  const isVideo = CONFIG.VIDEO_REGEX.test(path)
  const isApiCacheable = CONFIG.API_CACHE_REGEX.test(path)
  const isWebSocket = req.headers.get('Upgrade') === 'websocket'

  // --- 关键优化：视频流配置 ---
  const cfConfig = {
    // 视频流绝对禁止 cacheEverything，否则会导致严重的加载延迟
    cacheEverything: isVideo ? false : (isStatic || isApiCacheable),
    cacheTtl: isStatic ? 31536000 : (isApiCacheable ? 10 : 0),
    polish: isStatic ? 'lossy' : 'off',
    minify: 'off', // 视频传输不需要压缩代码
    mirage: false,
    scrapeShield: false,
    apps: false,
  }

  const fetchOptions = {
    method: req.method,
    headers: proxyHeaders,
    body: (['GET', 'HEAD'].includes(req.method) || url.pathname.includes('/Upload')) ? req.body : await req.arrayBuffer(),
    redirect: 'manual',
    cf: cfConfig
  }

  try {
    let response;
    // 视频流直连，避免超时控制器干扰大数据传输
    if (isVideo || isWebSocket || req.method === 'POST') {
      response = await fetch(targetUrl.toString(), fetchOptions)
    } else {
      try {
        response = await fetchWithTimeout(targetUrl.toString(), fetchOptions, CONFIG.API_TIMEOUT)
      } catch (err) {
        response = await fetch(targetUrl.toString(), fetchOptions)
      }
    }

    const resHeaders = new Headers(response.headers)
    resHeaders.set('access-control-allow-origin', '*')

    // --- 针对安卓端播放器的卡顿优化 ---
    if (isVideo) {
        // 1. 强制关闭连接复用，防止安卓播放器因连接池满载导致的卡顿
        resHeaders.set('Connection', 'close')
        // 2. 移除可能导致解析负担的头
        resHeaders.delete('Content-Security-Policy')
        resHeaders.delete('X-Frame-Options')
    }

    if (isStatic && (response.status === 200 || response.status === 304)) {
        resHeaders.set('Cache-Control', 'public, max-age=31536000, immutable')
    }

    // 透传 206 状态码是解决拖动卡顿的核心
    return new Response(response.body, {
      status: response.status,
      headers: resHeaders
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: `Proxy Error: ${error.message}` }), { status: 502 })
  }
})

export default app