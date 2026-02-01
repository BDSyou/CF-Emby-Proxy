import { Hono } from 'hono'

const CONFIG = {
  UPSTREAM_URL: 'https://emos.best',

  PROXY_ID: 'eABCDEFGHs',
  PROXY_NAME: '@emos',

  STATIC_REGEX: /(\.(jpg|jpeg|png|gif|css|js|ico|svg|webp|woff|woff2)$)|(\/emby\/Items\/.*\/Images\/)/i,
  VIDEO_REGEX: /(\/Videos\/|\/Items\/.*\/(Stream|Download))/i,
  API_CACHE_REGEX: /(\/Items\/Resume|\/Users\/.*\/Items\/)/i,

  API_TIMEOUT: 2000
}

const app = new Hono()

async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(id)
  }
}

app.all('*', async (c) => {
  const req = c.req.raw
  const url = new URL(req.url)

  // 状态页
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return c.html(STATUS_PAGE_HTML)
  }
  if (url.pathname === '/ping') {
    return new Response('pong', { status: 200 })
  }

  /* ---------- /emby 直通（防 302 + 稳定 Cache Key） ---------- */
  const targetPath = url.pathname.startsWith('/emby')
    ? url.pathname
    : '/emby' + url.pathname

  const targetUrl = new URL(targetPath + url.search, CONFIG.UPSTREAM_URL)

  const isStatic = CONFIG.STATIC_REGEX.test(targetPath)
  const isVideo = CONFIG.VIDEO_REGEX.test(targetPath)
  const isApiCacheable =
    req.method === 'GET' && CONFIG.API_CACHE_REGEX.test(targetPath)
  const isWebSocket = req.headers.get('upgrade') === 'websocket'

  /* ---------- Hills 极限优化：Range 视频直接穿透 ---------- */
  if (isVideo && req.headers.has('range')) {
    return fetch(targetUrl, {
      method: req.method,
      headers: req.headers,
      body: req.body
    })
  }

  /* ---------- Header 构建（Yamb Cache 友好） ---------- */
  const headers = new Headers()
  const clientIp =
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-forwarded-for')

  headers.set('Host', targetUrl.hostname)
  headers.set('Origin', targetUrl.origin)
  headers.set('Referer', targetUrl.origin)

  headers.set('EMOS-PROXY-ID', CONFIG.PROXY_ID)
  headers.set('EMOS-PROXY-NAME', CONFIG.PROXY_NAME)
  if (clientIp) headers.set('X-Forwarded-For', clientIp)

  // ⚠️ Yamb：不透传 User-Agent（稳定 Cache Key）
  const passHeaders = isVideo
    ? ['range', 'accept']
    : ['authorization', 'accept', 'accept-language']

  for (const h of passHeaders) {
    const v = req.headers.get(h)
    if (v) headers.set(h, v)
  }

  /* ---------- Body ---------- */
  let body = null
  if (!['GET', 'HEAD'].includes(req.method)) {
    body = await req.arrayBuffer()
  }

  /* ---------- Yamb API TTL 分层 ---------- */
  const apiTtl =
    /Resume/i.test(targetPath) ? 5 :
    /Users\/.*\/Items/i.test(targetPath) ? 8 :
    0

  /* ---------- Cloudflare Cache 策略 ---------- */
  const cf = {
    cacheEverything: isStatic || isApiCacheable,
    cacheTtl: isStatic ? 31536000 : 0,
    cacheTtlByStatus: isApiCacheable && apiTtl
      ? { '200-299': apiTtl }
      : undefined,

    polish: isStatic ? 'lossy' : 'off',
    minify: isStatic ? { javascript: true, css: true, html: true } : undefined,

    // 视频彻底不让 CF 插手
    mirage: false,
    apps: false,
    scrapeShield: false
  }

  const fetchOptions = {
    method: req.method,
    headers,
    body,
    redirect: 'manual',
    cf
  }

  let upstream
  if (isVideo || isWebSocket) {
    upstream = await fetch(targetUrl, fetchOptions)
  } else {
    try {
      upstream = await fetchWithTimeout(
        targetUrl,
        fetchOptions,
        CONFIG.API_TIMEOUT
      )
    } catch {
      upstream = await fetch(targetUrl, fetchOptions)
    }
  }

  /* ---------- Response 处理 ---------- */
  const resHeaders = new Headers(upstream.headers)
  resHeaders.delete('content-security-policy')
  resHeaders.delete('clear-site-data')
  resHeaders.set('access-control-allow-origin', '*')

  // 静态资源强制缓存
  if (isStatic && upstream.status === 200) {
    resHeaders.set(
      'Cache-Control',
      'public, max-age=31536000, immutable'
    )
    resHeaders.delete('pragma')
    resHeaders.delete('expires')
  }

  // Hills：视频流稳定性
  if (isVideo) {
    resHeaders.set('Connection', 'close')
    resHeaders.set('Accept-Ranges', 'bytes')
  }

  // WebSocket
  if (upstream.status === 101) {
    return new Response(null, {
      status: 101,
      webSocket: upstream.webSocket,
      headers: resHeaders
    })
  }

  // 重定向修正
  if ([301, 302, 303, 307, 308].includes(upstream.status)) {
    const loc = resHeaders.get('location')
    if (loc) {
      const u = new URL(loc, targetUrl)
      resHeaders.set('Location', u.pathname + u.search)
    }
    return new Response(null, {
      status: upstream.status,
      headers: resHeaders
    })
  }

  return new Response(upstream.body, {
    status: upstream.status, // 含 206
    headers: resHeaders
  })
})

export default app
