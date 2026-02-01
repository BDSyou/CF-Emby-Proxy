import { Hono } from 'hono'

const CONFIG = {
  UPSTREAM_URL: 'https://emos.best',
  PROXY_ID: 'eO9M28W9Js',
  PROXY_NAME: '游',

  STATIC_REGEX: /(\.(jpg|jpeg|png|gif|css|js|ico|svg|webp|woff|woff2)$)|(\/emby\/Items\/.*\/Images\/)/i,
  VIDEO_REGEX: /(\/Videos\/|\/Items\/.*\/(Stream|Download))/i,
  API_CACHE_REGEX: /(\/Items\/Resume|\/Users\/.*\/Items\/)/i,
  API_TIMEOUT: 2000
}

const app = new Hono()

async function safeFetch(url, options, timeout) {
  const controller = new AbortController()
  const id = timeout
    ? setTimeout(() => controller.abort(), timeout)
    : null

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    })
  } catch (e) {
    return null
  } finally {
    if (id) clearTimeout(id)
  }
}

app.all('*', async (c) => {
  try {
    const req = c.req.raw
    const url = new URL(req.url)

    /* ---------- WebSocket：最优先 ---------- */
    if (
      req.headers.get('upgrade') === 'websocket' ||
      req.headers.get('sec-websocket-key')
    ) {
      return fetch(req)
    }

    /* ---------- 状态接口 ---------- */
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return c.text('Emby Proxy OK', 200)
    }

    const targetPath = url.pathname.startsWith('/emby')
      ? url.pathname
      : '/emby' + url.pathname

    const targetUrl = new URL(targetPath + url.search, CONFIG.UPSTREAM_URL)

    const isStatic = CONFIG.STATIC_REGEX.test(targetPath)
    const isVideo = CONFIG.VIDEO_REGEX.test(targetPath)
    const isApiCacheable =
      req.method === 'GET' && CONFIG.API_CACHE_REGEX.test(targetPath)

    /* ---------- Range 视频：绝对直通（无 body） ---------- */
    if (isVideo && req.headers.has('range')) {
      const h = new Headers(req.headers)
      h.set('Accept-Encoding', 'identity')
      h.set('Accept', '*/*')

      return fetch(targetUrl, {
        method: 'GET',
        headers: h
      })
    }

    /* ---------- Header 构建 ---------- */
    const headers = new Headers()
    headers.set('Host', targetUrl.hostname)
    headers.set('Origin', targetUrl.origin)
    headers.set('Referer', targetUrl.origin)
    headers.set('EMOS-PROXY-ID', CONFIG.PROXY_ID)
    headers.set('EMOS-PROXY-NAME', CONFIG.PROXY_NAME)

    const clientIp =
      req.headers.get('cf-connecting-ip') ||
      req.headers.get('x-forwarded-for')
    if (clientIp) headers.set('X-Forwarded-For', clientIp)

    const passHeaders = isVideo
      ? ['accept']
      : ['authorization', 'accept', 'accept-language']

    for (const h of passHeaders) {
      const v = req.headers.get(h)
      if (v) headers.set(h, v)
    }

    /* ---------- Body（严格限制） ---------- */
    let body = null
    if (!['GET', 'HEAD'].includes(req.method)) {
      body = await req.arrayBuffer()
    }

    const cf = {
      cacheEverything: isStatic || isApiCacheable,
      cacheTtl: isStatic ? 31536000 : 0,
      polish: isStatic ? 'lossy' : 'off'
    }

    const upstream =
      isVideo
        ? await safeFetch(targetUrl, { method: req.method, headers, body }, null)
        : await safeFetch(
            targetUrl,
            { method: req.method, headers, body, cf },
            CONFIG.API_TIMEOUT
          )

    if (!upstream) {
      return new Response('Upstream Fetch Failed', { status: 502 })
    }

    /* ---------- Response ---------- */
    const resHeaders = new Headers(upstream.headers)
    resHeaders.set('access-control-allow-origin', '*')
    resHeaders.delete('content-security-policy')

    if (isVideo && !resHeaders.get('Content-Type')) {
      resHeaders.set('Content-Type', 'application/octet-stream')
    }

    return new Response(
      req.method === 'HEAD' ? null : upstream.body,
      {
        status: upstream.status,
        headers: resHeaders
      }
    )
  } catch (e) {
    return new Response(
      'Worker Internal Error',
      { status: 500 }
    )
  }
})

export default app
