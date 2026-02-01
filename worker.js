import { Hono } from 'hono'

/* ================= 配置 ================= */
const CONFIG = {
  UPSTREAM_URL: 'https://emos.best',

  // 身份标识（必须）
  PROXY_ID: 'eO9M28W9Js',
  PROXY_NAME: '游',

  STATIC_REGEX: /(\.(jpg|jpeg|png|gif|css|js|ico|svg|webp|woff|woff2)$)|(\/emby\/Items\/.*\/Images\/)/i,
  VIDEO_REGEX: /(\/Videos\/|\/Items\/.*\/(Stream|Download))/i,
  API_CACHE_REGEX: /(\/Items\/Resume|\/Users\/.*\/Items\/)/i,

  API_TIMEOUT: 2000
}

const app = new Hono()

/* ================= 工具函数 ================= */
async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(id)
  }
}

function simplifyUA(ua) {
  if (/Hills/i.test(ua)) return 'Hills'
  if (/Yamb/i.test(ua)) return 'Yamb'
  if (/Emby/i.test(ua)) return 'Emby'
  if (/Android/i.test(ua)) return 'Android'
  if (/iPhone|iPad/i.test(ua)) return 'iOS'
  if (/Chrome/i.test(ua)) return 'Chrome'
  return 'Unknown'
}

/* ================= 状态页 ================= */
async function renderStatusPage(c) {
  const start = Date.now()
  let latency = '—'
  let status = '运行正常'

  try {
    await fetch(CONFIG.UPSTREAM_URL, { method: 'HEAD' })
    latency = Date.now() - start
  } catch {
    status = '无法连接'
  }

  const req = c.req.raw
  const cf = req.cf || {}

  const ip =
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for') ||
    'Unknown'

  const ua = simplifyUA(c.req.header('user-agent') || '')

  return c.html(
    buildStatusHTML({
      latency,
      status,
      ua,
      ip,
      country: cf.country || 'Unknown',
      colo: cf.colo || 'Unknown'
    }),
    { headers: { 'Cache-Control': 'no-store' } }
  )
}

function buildStatusHTML(d) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>Emby 反代状态</title>
<style>
body{background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont}
.card{max-width:760px;margin:40px auto;background:#fff;border-radius:18px;
padding:36px;box-shadow:0 10px 30px rgba(0,0,0,.08)}
h1{text-align:center}
.badge{background:#22c55e;color:#fff;padding:6px 16px;border-radius:999px}
.latency{margin:28px 0;padding:32px;border-radius:16px;
background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-align:center}
.latency strong{font-size:52px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.box{background:#f1f5f9;padding:18px;border-radius:14px}
.clients{margin-top:26px;background:#ecfeff;padding:18px;border-radius:14px}
.clients span{display:inline-block;margin:6px;padding:6px 14px;
background:#e0f2fe;border-radius:999px;font-size:13px}
</style>
</head>
<body>
<div class="card">
<h1>Emby 反代状态</h1>
<p style="text-align:center"><span class="badge">${d.status}</span></p>

<div class="latency">
<div>总响应延迟</div>
<strong>${d.latency} ms</strong>
<div>极速</div>
</div>

<div class="grid">
<div class="box">设备类型<br><strong>${d.ua}</strong></div>
<div class="box">请求地区<br><strong>${d.country}</strong></div>
<div class="box">CF 节点<br><strong>${d.colo}</strong></div>
<div class="box">客户端 IP<br><strong>${d.ip}</strong></div>
</div>

<div class="clients">
<strong>推荐客户端：</strong><br>
<span>Hills</span><span>Yamby</span><span>EplayerX</span>
<span>SenPlayer</span><span>Forward</span><span>Vidora</span>
</div>
</div>
</body>
</html>`
}

/* ================= 主逻辑 ================= */
app.all('*', async (c) => {
  const req = c.req.raw
  const url = new URL(req.url)

  /* ---- 状态页 & ping ---- */
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return renderStatusPage(c)
  }
  if (url.pathname === '/ping') {
    return new Response('pong', { status: 200 })
  }

  /* ---- /emby 统一入口 ---- */
  const targetPath = url.pathname.startsWith('/emby')
    ? url.pathname
    : '/emby' + url.pathname

  const targetUrl = new URL(targetPath + url.search, CONFIG.UPSTREAM_URL)

  const isStatic = CONFIG.STATIC_REGEX.test(targetPath)
  const isVideo = CONFIG.VIDEO_REGEX.test(targetPath)
  const isApiCacheable =
    req.method === 'GET' && CONFIG.API_CACHE_REGEX.test(targetPath)
  const isWebSocket = req.headers.get('upgrade') === 'websocket'

  /* ---- Hills Range 穿透 ---- */
  if (isVideo && req.headers.has('range')) {
    return fetch(targetUrl, {
      method: req.method,
      headers: req.headers,
      body: req.body
    })
  }

  /* ---- Header 构建 ---- */
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

  const passHeaders = isVideo
    ? ['range', 'accept']
    : ['authorization', 'accept', 'accept-language']

  for (const h of passHeaders) {
    const v = req.headers.get(h)
    if (v) headers.set(h, v)
  }

  let body = null
  if (!['GET', 'HEAD'].includes(req.method)) {
    body = await req.arrayBuffer()
  }

  const apiTtl =
    /Resume/i.test(targetPath) ? 5 :
    /Users\/.*\/Items/i.test(targetPath) ? 8 :
    0

  const cf = {
    cacheEverything: isStatic || isApiCacheable,
    cacheTtl: isStatic ? 31536000 : 0,
    cacheTtlByStatus: isApiCacheable && apiTtl
      ? { '200-299': apiTtl }
      : undefined,
    polish: isStatic ? 'lossy' : 'off',
    minify: isStatic ? { javascript: true, css: true, html: true } : undefined,
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

  const resHeaders = new Headers(upstream.headers)
  resHeaders.delete('content-security-policy')
  resHeaders.delete('clear-site-data')
  resHeaders.set('access-control-allow-origin', '*')

  if (isStatic && upstream.status === 200) {
    resHeaders.set(
      'Cache-Control',
      'public, max-age=31536000, immutable'
    )
    resHeaders.delete('pragma')
    resHeaders.delete('expires')
  }

  if (isVideo) {
    resHeaders.set('Connection', 'close')
    resHeaders.set('Accept-Ranges', 'bytes')
  }

  if (upstream.status === 101) {
    return new Response(null, {
      status: 101,
      webSocket: upstream.webSocket,
      headers: resHeaders
    })
  }

  if ([301,302,303,307,308].includes(upstream.status)) {
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
    status: upstream.status,
    headers: resHeaders
  })
})

export default app
