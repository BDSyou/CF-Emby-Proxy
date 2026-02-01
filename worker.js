import { Hono } from 'hono'

const CONFIG = {
  UPSTREAM_URL: 'https://emos.best', 
  PROXY_ID: 'eO9M28W9Js',
  PROXY_NAME: 'you',
  // 路径前缀定义
  BASE_PATH: '/emby',
  // 扩展静态资源匹配，增加对包含 /emby 路径的处理
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
  
  // --- 路径补全逻辑 ---
  // 如果请求路径不以 /emby 开头，且不是根路径，则自动加上 /emby 转发给源站
  let path = url.pathname
  if (!path.startsWith(CONFIG.BASE_PATH) && path !== '/') {
    path = CONFIG.BASE_PATH + path
  }
  
  const targetUrl = new URL(path + url.search, CONFIG.UPSTREAM_URL)
  
  const proxyHeaders = new Headers(req.headers)
  proxyHeaders.set('Host', targetUrl.hostname)
  proxyHeaders.set('Referer', targetUrl.origin)
  proxyHeaders.set('Origin', targetUrl.origin)
  proxyHeaders.set('EMOS-PROXY-ID', CONFIG.PROXY_ID)
  proxyHeaders.set('EMOS-PROXY-NAME', CONFIG.PROXY_NAME)

  // 必须传递 X-FORWARDED-FOR 供源站校验
  const clientIp = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')
  if (clientIp) {
    proxyHeaders.set('X-Forwarded-For', clientIp)
  }

  proxyHeaders.delete('cf-connecting-ip')
  proxyHeaders.delete('cf-ray')
  proxyHeaders.delete('cf-visitor')

  let reqBody = req.body
  if (!['GET', 'HEAD'].includes(req.method) && !url.pathname.includes('/Upload')) {
    reqBody = await req.arrayBuffer()
    proxyHeaders.delete('content-length')
  }

  const isStatic = CONFIG.STATIC_REGEX.test(path)
  const isVideo = CONFIG.VIDEO_REGEX.test(path)
  const isApiCacheable = CONFIG.API_CACHE_REGEX.test(path)
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
    resHeaders.delete('clear-site-data')
    resHeaders.set('access-control-allow-origin', '*')

    if (isVideo) {
      resHeaders.set('Connection', 'close')
    }

    if (isStatic && (response.status === 200 || response.status === 304)) {
      resHeaders.set('Cache-Control', 'public, max-age=31536000, immutable')
    }

    if (response.status === 101) {
      return new Response(null, { status: 101, webSocket: response.webSocket, headers: resHeaders })
    }

    // 重定向修正：确保重定向后的 Location 不会丢失 /emby 前缀或产生双重前缀
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = resHeaders.get('location')
      if (location) {
        const locUrl = new URL(location, targetUrl.href)
        if (locUrl.hostname === targetUrl.hostname) {
          // 返回给客户端时，统一抹掉源站的 /emby 前缀，由 Worker 重新处理逻辑，或者保持相对路径
          resHeaders.set('Location', locUrl.pathname + locUrl.search)
        }
      }
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