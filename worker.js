import { Hono } from 'hono'

const CONFIG = {
  UPSTREAM_URL: 'https://emos.best',

  // 必须的身份标识
  PROXY_ID: 'eO9M28W9Js', // 请替换为你的真实 ID
  PROXY_NAME: '游',     // 请替换为你的真实称号

  // 静态资源（图片 + 前端资源）
  STATIC_REGEX: /(\.(jpg|jpeg|png|gif|css|js|ico|svg|webp|woff|woff2)$)|(\/emby\/Items\/.*\/Images\/)/i,

  // 视频流（206 必须直连）
  VIDEO_REGEX: /(\/Videos\/|\/Items\/.*\/(Stream|Download))/i,

  // API 微缓存
  API_CACHE_REGEX: /(\/Items\/Resume|\/Users\/.*\/Items\/)/i,

  API_TIMEOUT: 2000
}

const app = new Hono()

// 带超时 fetch（仅用于 API）
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

  /* ---------------- 核心优化点 1：路径直通 /emby ---------------- */
  const targetPath = url.pathname.startsWith('/emby')
    ? url.pathname
    : '/emby' + url.pathname

  const targetUrl = new URL(targetPath + url.search, CONFIG.UPSTREAM_URL)

  /* ---------------- 核心优化点 2：最小化请求头 ---------------- */
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

  // 只透传必要头
  const passHeaders = [
    'authorization',
    'range',
    'if-none-match',
    'if-modified-since',
    'user-agent',
    'accept',
    'accept-language',
    'content-type'
  ]
  for (const h of passHeaders) {
    const v = req.headers.get(h)
    if (v) headers.set(h, v)
  }

  /* ---------------- 请求体优化 ---------------- */
  let body = null
  if (!['GET', 'HEAD'].includes(req.method)) {
    body = await req.arrayBuffer()
  }

  const isStatic = CONFIG.STATIC_REGEX.test(targetPath)
  const isVideo = CONFIG.VIDEO_REGEX.test(targetPath)
  const isApiCacheable =
    req.method === 'GET' && CONFIG.API_CACHE_REGEX.test(targetPath)
  const isWebSocket = req.headers.get('upgrade') === 'websocket'

  /* ---------------- 核心优化点 3：CF Cache 精准配置 ---------------- */
  const cf = {
    cacheEverything: isStatic || isApiCacheable,
    cacheTtl: isStatic ? 31536000 : 0,
    cacheTtlByStatus: isApiCacheable ? { '200-299': 10 } : undefined,

    polish: isStatic ? 'lossy' : 'off',
    minify: isStatic ? { javascript: true, css: true, html: true } : undefined,

    // 视频流彻底关闭一切 CF 干预
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

  let upstreamResponse

  /* ---------------- 核心优化点 4：视频 / 206 绝对直连 ---------------- */
  if (isVideo || isWebSocket) {
    upstreamResponse = await fetch(targetUrl, fetchOptions)
  } else {
    try {
      upstreamResponse = await fetchWithTimeout(
        targetUrl,
        fetchOptions,
        CONFIG.API_TIMEOUT
      )
    } catch {
      upstreamResponse = await fetch(targetUrl, fetchOptions)
    }
  }

  /* ---------------- 响应头优化 ---------------- */
  const resHeaders = new Headers(upstreamResponse.headers)

  resHeaders.delete('content-security-policy')
  resHeaders.delete('clear-site-data')
  resHeaders.set('access-control-allow-origin', '*')

  // 强制静态缓存命中
  if (isStatic && upstreamResponse.status === 200) {
    resHeaders.set(
      'Cache-Control',
      'public, max-age=31536000, immutable'
    )
    resHeaders.delete('pragma')
    resHeaders.delete('expires')
  }

  // 视频流：禁止 keep-alive，防止播放器卡首包
  if (isVideo) {
    resHeaders.set('Connection', 'close')
  }

  // WebSocket
  if (upstreamResponse.status === 101) {
    return new Response(null, {
      status: 101,
      webSocket: upstreamResponse.webSocket,
      headers: resHeaders
    })
  }

  // 重定向修正
  if ([301, 302, 303, 307, 308].includes(upstreamResponse.status)) {
    const loc = resHeaders.get('location')
    if (loc) {
      const u = new URL(loc, targetUrl)
      resHeaders.set('Location', u.pathname + u.search)
    }
    return new Response(null, {
      status: upstreamResponse.status,
      headers: resHeaders
    })
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status, // 含 206
    headers: resHeaders
  })
})

export default app
