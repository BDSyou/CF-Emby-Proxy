import { Hono } from 'hono'

const CONFIG = {
  UPSTREAM_URL: 'https://emos.best', 
  PROXY_ID: 'eO9M28W9Js', 
  PROXY_NAME: '游',      
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

  // 1. 基础页面
  if (url.pathname === '/' || url.pathname === '/index.html') return c.html(STATUS_PAGE_HTML)
  if (url.pathname === '/ping') return new Response('pong', { status: 200 })

  // 2. 构造回源
  const targetUrl = new URL('/emby' + url.pathname + url.search, CONFIG.UPSTREAM_URL)
  const proxyHeaders = new Headers(req.headers)
  
  proxyHeaders.set('Host', targetUrl.hostname)
  proxyHeaders.set('EMOS-PROXY-ID', CONFIG.PROXY_ID)
  proxyHeaders.set('EMOS-PROXY-NAME', CONFIG.PROXY_NAME)

  const clientIp = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')
  if (clientIp) {
    proxyHeaders.set('X-Forwarded-For', clientIp)
  }

  // 优化传输
  proxyHeaders.delete('cf-connecting-ip')
  proxyHeaders.delete('cf-ray')
  proxyHeaders.delete('cf-visitor')

  const isStatic = CONFIG.STATIC_REGEX.test(url.pathname)
  const isVideo = CONFIG.VIDEO_REGEX.test(url.pathname)
  const isApiCacheable = CONFIG.API_CACHE_REGEX.test(url.pathname)
  const isWebSocket = req.headers.get('Upgrade') === 'websocket'

  // 3. 静态缓存读取
  if (isStatic && req.method === 'GET') {
    let cachedResponse = await cache.match(cacheKey)
    if (cachedResponse) {
      const h = new Headers(cachedResponse.headers)
      h.set('X-Proxy-Cache', 'HIT')
      return new Response(cachedResponse.body, { headers: h })
    }
  }

  // --- [核心修复] 请求体处理逻辑 ---
  let body = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // 必须保留原始的 Content-Type，否则后端无法识别媒体类型
    body = await req.arrayBuffer();
  }

  const cfConfig = {
    cacheEverything: isStatic || isApiCacheable,
    cacheTtl: isStatic ? 31536000 : (isApiCacheable ? 10 : 0),
    polish: isStatic ? 'lossy' : 'off',
    jumpStart: true
  }

  const fetchOptions = {
    method: req.method,
    headers: proxyHeaders,
    body: body,
    redirect: 'manual',
    cf: cfConfig
  }

  try {
    let response;
    // 4. 发起请求
    if (isVideo || isWebSocket || req.method !== 'GET') {
      // 非 GET 请求（如 POST）绝不使用超时重试，防止 Body 损坏
      response = await fetch(targetUrl.toString(), fetchOptions)
    } else {
      try {
        response = await fetchWithTimeout(targetUrl.toString(), fetchOptions, CONFIG.API_TIMEOUT)
      } catch {
        response = await fetch(targetUrl.toString(), fetchOptions)
      }
    }

    const resHeaders = new Headers(response.headers)
    resHeaders.set('access-control-allow-origin', '*')
    
    // 5. 状态码透传 (核心：确保 206, 204 等正常返回)
    if (isVideo) resHeaders.set('Connection', 'close')

    // 6. 缓存入库
    if (isStatic && response.status === 200 && req.method === 'GET') {
      resHeaders.set('Cache-Control', 'public, max-age=31536000, immutable')
      const cacheResponse = new Response(response.body, { ...response, headers: resHeaders })
      c.executionCtx.waitUntil(cache.put(cacheKey, cacheResponse.clone()))
      return cacheResponse
    }

    return new Response(response.body, {
      status: response.status,
      headers: resHeaders
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 502 })
  }
})

export default app

const STATUS_PAGE_HTML = ``