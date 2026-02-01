import { Hono } from 'hono'

const CONFIG = {
  UPSTREAM_URL: 'https://emos.best', 
  PROXY_ID: 'eO9M28W9Js', 
  PROXY_NAME: 'you',       
  BASE_PATH: '/emby',
  
  // 静态资源：海报、图标、脚本
  STATIC_REGEX: /(\.(jpg|jpeg|png|gif|css|js|ico|svg|webp|woff|woff2)|(\/Images\/(Primary|Backdrop|Logo|Thumb|Banner|Art))|(\/emby\/Items\/.*\/Images\/))/i,
  
  // 视频流：Videos, Download, Stream, m3u8, ts
  VIDEO_REGEX: /(\/Videos\/|\/Items\/.*\/Download|\/Items\/.*\/Stream|\.m3u8|\.ts)/i,
  
  // 交互 API 缓存
  API_CACHE_REGEX: /(\/Items\/Resume|\/Users\/.*\/Items\/)/i,
  
  API_TIMEOUT: 2500
}

const app = new Hono()

// 针对图片和 API 的超时处理
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
  
  // 1. 路径自动补全 (解决安卓 App 登录 404 问题)
  let path = url.pathname
  if (!path.startsWith(CONFIG.BASE_PATH) && path !== '/') {
    path = CONFIG.BASE_PATH + path
  }
  
  const targetUrl = new URL(path + url.search, CONFIG.UPSTREAM_URL)
  const proxyHeaders = new Headers(req.headers)
  
  // 2. 头部修复 (UA 透传 + 身份识别)
  const originalUA = req.headers.get('User-Agent')
  if (originalUA) proxyHeaders.set('User-Agent', originalUA)

  proxyHeaders.set('Host', targetUrl.hostname)
  proxyHeaders.set('Referer', targetUrl.origin)
  proxyHeaders.set('Origin', targetUrl.origin)
  proxyHeaders.set('EMOS-PROXY-ID', CONFIG.PROXY_ID)
  proxyHeaders.set('EMOS-PROXY-NAME', CONFIG.PROXY_NAME)

  // 3. IP 透传 (安卓端源站风控绕过)
  const clientIp = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')
  if (clientIp) {
    proxyHeaders.set('X-Forwarded-For', clientIp)
    proxyHeaders.set('X-Real-IP', clientIp)
  }

  // 清除冗余头
  proxyHeaders.delete('cf-ray')
  proxyHeaders.delete('cf-visitor')

  const isVideo = CONFIG.VIDEO_REGEX.test(path)
  const isStatic = CONFIG.STATIC_REGEX.test(path)
  const isApiCacheable = CONFIG.API_CACHE_REGEX.test(path)
  const isWebSocket = req.headers.get('Upgrade') === 'websocket'

  // 4. 传输策略优化 (解决卡顿核心)
  const cfConfig = {
    // 视频流必须禁止边缘缓存，否则会阻塞第一个分片的下发
    cacheEverything: isVideo ? false : (isStatic || isApiCacheable),
    cacheTtl: isStatic ? 31536000 : 0,
    // 只有图片开启 polish 压缩，视频必须关闭所有处理
    polish: isStatic ? 'lossy' : 'off',
    minify: 'off',
    mirage: false,
    scrapeShield: false,
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
    // 视频、Socket、POST 必须直连且不设超时，防止大文件传输被 Worker 强制截断
    if (isVideo || isWebSocket || req.method === 'POST') {
      response = await fetch(targetUrl.toString(), fetchOptions)
    } else {
      try {
        response = await fetchWithTimeout(targetUrl.toString(), fetchOptions, CONFIG.API_TIMEOUT)
      } catch (err) {
        response = await fetch(targetUrl.toString(), fetchOptions)
      }
    }

    // 5. 响应处理
    const resHeaders = new Headers(response.headers)
    
    // 移除 CSP 等干扰头
    resHeaders.delete('content-security-policy')
    resHeaders.set('access-control-allow-origin', '*')

    // 强制静态资源强缓存 (忽略源站的 private/no-cache 标记)
    if (isStatic && (response.status === 200 || response.status === 304)) {
        resHeaders.set('Cache-Control', 'public, max-age=31536000, immutable')
        resHeaders.delete('Pragma')
    }

    // 处理安卓端 206 Partial Content (这是播放和拖动的关键)
    if (response.status === 206) {
        return new Response(response.body, {
            status: 206,
            headers: resHeaders
        })
    }

    // 处理视频流链接
    if (isVideo) {
        resHeaders.set('Connection', 'close') // 强制非持久连接，加速流释放
    }

    // 处理 WebSocket
    if (response.status === 101) {
      return new Response(null, { status: 101, webSocket: response.webSocket, headers: resHeaders })
    }

    // 重定向修正
    if ([301, 302, 303, 307, 308].includes(response.status)) {
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