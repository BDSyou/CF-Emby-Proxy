import { Hono } from 'hono'

const CONFIG = {
  UPSTREAM_URL: 'https://emby.heiyou.top', 
  PROXY_ID: 'eO9M28W9Js', 
  PROXY_NAME: '@you', 
  BASE_PATH: '/emby',
  
  IMAGE_CACHE_TTL: 604800,
  PING_CACHE_TTL: 60,
  PROGRESS_THROTTLE_MS: 5000, 
  
  STATIC_REGEX: /(\.(jpg|jpeg|png|gif|css|js|ico|svg|webp|woff|woff2)|(\/Images\/(Primary|Backdrop|Logo|Thumb|Banner|Art))|(\/emby\/Items\/.*\/Images\/))/i,
  VIDEO_REGEX: /(\/Videos\/|\/Items\/.*\/Download|\/Items\/.*\/Stream|\.m3u8|\.ts)/i,
  API_CACHE_REGEX: /(\/Items\/Resume|\/Users\/.*\/Items\/)/i,
  API_TIMEOUT: 2500
}

const progressThrottleMap = new Map()
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

function getProgressThrottleKey(headers) {
  const sessionId = headers.get('X-Emby-Session-Id') || headers.get('X-MediaBrowser-Session-Id') || 'unknown'
  const token = headers.get('X-Emby-Token') || headers.get('X-MediaBrowser-Token') || 'unknown'
  return `${sessionId}_${token}`
}

app.all('*', async (c) => {
  const req = c.req.raw
  const url = new URL(req.url)
  
  let path = url.pathname
  if (!path.startsWith(CONFIG.BASE_PATH) && path !== '/') {
    path = CONFIG.BASE_PATH + path
  }
  
  // ✅ 节流逻辑：保持原样，非常棒
  if (req.method === 'POST' && path === '/emby/Sessions/Playing/Progress') {
    const throttleKey = getProgressThrottleKey(req.headers)
    const now = Date.now()
    const lastTime = progressThrottleMap.get(throttleKey) || 0
    if (now - lastTime < CONFIG.PROGRESS_THROTTLE_MS) {
      return new Response(null, { status: 204 })
    }
    progressThrottleMap.set(throttleKey, now)
  }
  
  const targetUrl = new URL(path + url.search, CONFIG.UPSTREAM_URL)
  const proxyHeaders = new Headers(req.headers)
  
  proxyHeaders.set('Host', targetUrl.hostname)
  proxyHeaders.set('Referer', targetUrl.origin)
  proxyHeaders.set('Origin', targetUrl.origin)
  proxyHeaders.set('EMOS-PROXY-ID', CONFIG.PROXY_ID)
  proxyHeaders.set('EMOS-PROXY-NAME', CONFIG.PROXY_NAME)

  const clientIp = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')
  if (clientIp) {
    proxyHeaders.set('X-Forwarded-For', clientIp)
    proxyHeaders.set('X-Real-IP', clientIp)
  }

  proxyHeaders.delete('cf-ray')
  proxyHeaders.delete('cf-visitor')

  const isVideo = CONFIG.VIDEO_REGEX.test(path)
  const isStatic = CONFIG.STATIC_REGEX.test(path)
  const isImage = /\/emby\/Items\/[^/]+\/Images\//i.test(path)
  const isPing = path === '/emby/System/Ping'
  const isWebSocket = req.headers.get('Upgrade') === 'websocket'

  // ✅ 策略优化
  const cfConfig = {
    cacheEverything: isVideo ? false : (isStatic || isImage || isPing),
    cacheTtl: isImage ? CONFIG.IMAGE_CACHE_TTL : (isPing ? CONFIG.PING_CACHE_TTL : (isStatic ? 31536000 : 0)),
    polish: (isStatic || isImage) ? 'lossy' : 'off',
    minify: 'off',
  }

  const fetchOptions = {
    method: req.method,
    headers: proxyHeaders,
    // ✅ 优化：全流式转发，不再 await arrayBuffer()
    body: (['GET', 'HEAD'].includes(req.method)) ? null : req.body,
    redirect: 'manual',
    cf: cfConfig
  }

  try {
    let response;
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
    resHeaders.delete('content-security-policy')
    resHeaders.set('access-control-allow-origin', '*')
    resHeaders.set('X-Proxy-Name', CONFIG.PROXY_NAME)

    // ✅ 强缓存处理
    if ((isStatic || isImage) && (response.status === 200 || response.status === 304)) {
        resHeaders.set('Cache-Control', `public, max-age=${isImage ? CONFIG.IMAGE_CACHE_TTL : 31536000}, immutable`)
        resHeaders.delete('Pragma')
    }
    
    if (isPing && response.status === 200) {
        resHeaders.set('Cache-Control', `public, max-age=${CONFIG.PING_CACHE_TTL}`)
    }

    // ✅ 处理 206：确保 Accept-Ranges 存在
    if (response.status === 206) {
        resHeaders.set('Accept-Ranges', 'bytes')
        return new Response(response.body, {
            status: 206,
            headers: resHeaders
        })
    }

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

    return new Response(response.body, {
      status: response.status,
      headers: resHeaders
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: `Proxy Error: ${error.message}` }), { status: 502 })
  }
})

export default app