import { Hono } from 'hono'

const CONFIG = {
  UPSTREAM_URL: 'https://emos.best', // Replace with your Emby server URL
  // [关键修复] 
  // 1. 增加自定义身份标识
  PROXY_ID: 'eO9M28W9Js', // 请替换为你的真实 ID
  PROXY_NAME: '游',     // 请替换为你的真实称号
  
  // 2. 匹配 Emby 特有的无后缀图片路径 (/Images/Primary, /Images/Backdrop 包含 /emby/Items/*/Images/* 路径
  STATIC_REGEX: /(\.(jpg|jpeg|png|gif|css|js|ico|svg|webp|woff|woff2)|(\/Images\/(Primary|Backdrop|Logo|Thumb|Banner|Art))|(\/emby\/Items\/.*\/Images\/))/i,
  // 视频流 (直连，不缓存，不重试)
  VIDEO_REGEX: /(\/Videos\/|\/Items\/.*\/Download|\/Items\/.*\/Stream)/i,
  
  // [新增] 慢接口微缓存 (解决 Resume 1.5s 的问题)
  // 缓存 API 响应 5-10秒，大幅提升"返回/进入"页面的流畅度，同时不影响数据准确性
  API_CACHE_REGEX: /(\/Items\/Resume|\/Users\/.*\/Items\/)/i,
  
  // API超时设置
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

  // 如果访问根路径，显示延迟检测页面
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return c.html(STATUS_PAGE_HTML)
  }
  if (url.pathname === '/ping') {
    return new Response('pong', { status: 200 })
}

  // 强制使用 HTTPS 协议回源
  const targetUrl = new URL('/emby' + url.pathname + url.search, CONFIG.UPSTREAM_URL)
  
  const proxyHeaders = new Headers(req.headers)
  proxyHeaders.set('Host', targetUrl.hostname)
  proxyHeaders.set('Referer', targetUrl.origin)
  proxyHeaders.set('Origin', targetUrl.origin)
  
  // --- [修改] 满足要求：增加身份头部 & 传递 X-Forwarded-For ---
  proxyHeaders.set('EMOS-PROXY-ID', CONFIG.PROXY_ID)
  proxyHeaders.set('EMOS-PROXY-NAME', CONFIG.PROXY_NAME)
  // 获取客户端真实 IP 并传递
  const clientIp = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')
  if (clientIp) {
    proxyHeaders.set('X-Forwarded-For', clientIp)
  }

  // 剔除杂项头
  proxyHeaders.delete('cf-connecting-ip')
  //proxyHeaders.delete('x-forwarded-for')   //保留 X-Forwarded-For
  proxyHeaders.delete('cf-ray')
  proxyHeaders.delete('cf-visitor')

  // 仅缓冲关键非流式交互
  let reqBody = req.body
  if (!['GET', 'HEAD'].includes(req.method) && !url.pathname.includes('/Upload')) {
    reqBody = await req.arrayBuffer()
    proxyHeaders.delete('content-length')
  }

  // --- 判别请求类型 ---
  const isStatic = CONFIG.STATIC_REGEX.test(url.pathname)
  const isVideo = CONFIG.VIDEO_REGEX.test(url.pathname)
  const isApiCacheable = CONFIG.API_CACHE_REGEX.test(url.pathname)
  const isWebSocket = req.headers.get('Upgrade') === 'websocket'

  // --- Cloudflare 策略配置 ---
  const cfConfig = {
    // 1. 静态图片：强力缓存 1 年
    cacheEverything: isStatic,
    cacheTtl: isStatic ? 31536000 : 0,
    
    // 2. API 微缓存：缓存 10 秒 (解决 Resume 接口慢的问题)
    // 注意：只有 GET 请求才会生效 cacheTtl
    cacheTtlByStatus: isApiCacheable ? { "200-299": 10 } : null,

    // 3. 性能优化开关
    // 静态资源：开启有损压缩 (polish) 以加快图片传输
    // 视频资源：彻底关闭所有处理 (off)
    polish: isStatic ? 'lossy' : 'off',
    minify: { javascript: isStatic, css: isStatic, html: isStatic },
    
    // 4. 视频流核心：关闭缓冲
    mirage: false,
    scrapeShield: false,
    apps: false,
  }

  // 如果是 API 微缓存，也需要开启 cacheEverything 才能生效
  if (isApiCacheable) {
    cfConfig.cacheEverything = true
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

    // 视频流 & Socket -> 直连 (无超时，无重试)
    // --- [修改] 处理 206 状态码 ---
    // 206 Partial Content 通常用于视频流分段，必须直连不超时
    if (isVideo || isWebSocket || req.method === 'POST') {
      response = await fetch(targetUrl.toString(), fetchOptions)
    } else {
      // API & 图片 -> 带超时重试
      try {
        response = await fetchWithTimeout(targetUrl.toString(), fetchOptions, CONFIG.API_TIMEOUT)
      } catch (err) {
        response = await fetch(targetUrl.toString(), fetchOptions)
      }
    }

    // --- 响应处理 ---
    const resHeaders = new Headers(response.headers)
    resHeaders.delete('content-security-policy')
    resHeaders.delete('clear-site-data')
    resHeaders.set('access-control-allow-origin', '*')

    // [关键] 视频流强制关闭连接，防止自动播放卡死
    if (isVideo) {
        resHeaders.set('Connection', 'close')
    }
    
    // [补充] 强制静态图片缓存命中
    // Emby 有时会返回 private 或 no-cache 头，导致 CF 即使配置了 cacheEverything 也不缓存
    // 我们强制覆盖这些头
    if (isStatic && response.status === 200) {
        resHeaders.set('Cache-Control', 'public, max-age=31536000, immutable')
        resHeaders.delete('Pragma')
        resHeaders.delete('Expires')
    }

    // --- [处理] WebSocket & 重定向 & 206 ---
    if (response.status === 101) {
      return new Response(null, { status: 101, webSocket: response.webSocket, headers: resHeaders })
    }
    // 显式支持 206 状态码
    const status = response.status;
    // 修正重定向
    if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = resHeaders.get('location')
        if (location) {
             const locUrl = new URL(location, targetUrl.href) // 兼容相对路径
             if (locUrl.hostname === targetUrl.hostname) {
                 resHeaders.set('Location', locUrl.pathname + locUrl.search)
             }
        }
        return new Response(null, { status: response.status, headers: resHeaders })
    }

    // 返回响应时保持原始状态码（包括 206）
    return new Response(response.body, {
      status: status,
      headers: resHeaders
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: `Proxy Error: ${error.message}` }), { status: 502 })
  }
})

export default app

const STATUS_PAGE_HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>EMBY反代延迟检测</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background: #f3f4f6; font-family: sans-serif; }
        .glass-card { background: rgba(255, 255, 255, 0.8); backdrop-filter: blur(10px); border-radius: 20px; }
        .gradient-text { background: linear-gradient(90deg, #3b82f6, #2dd4bf); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    </style>
</head>
<body class="flex items-center justify-center min-h-screen p-4">
    <div class="max-w-md w-full space-y-4">
        <h1 class="text-center text-xl font-bold flex items-center justify-center gap-2">
            ⚡ EMBY反代延迟检测
        </h1>
        <p class="text-center text-gray-500 text-sm">实时测量您连接到EMBY服务器的网络延迟</p>
        
        <div class="bg-gradient-to-r from-blue-500 to-cyan-400 p-8 rounded-[30px] shadow-lg text-center text-white relative overflow-hidden">
            <div class="text-xs opacity-80 mb-2">● 实时延迟</div>
            <div id="latency" class="text-6xl font-bold">--ms</div>
            <div id="status-tag" class="mt-4 inline-block bg-white/20 px-4 py-1 rounded-full text-xs">检测中...</div>
        </div>

        <div class="glass-card p-6 shadow-sm grid grid-cols-2 gap-4">
            <div>
                <div class="text-gray-400 text-xs">所在地区</div>
                <div id="location" class="font-medium text-sm">加载中...</div>
            </div>
            <div>
                <div class="text-gray-400 text-xs">CF节点</div>
                <div id="colo" class="font-medium text-sm text-blue-500">获取中...</div>
            </div>
        </div>

        <div class="glass-card p-6 shadow-sm space-y-3">
            <h2 class="text-sm font-bold flex items-center gap-2">💻 设备信息</h2>
            <div class="grid grid-cols-2 gap-y-2 text-xs text-gray-600">
                <div>浏览器: <span id="ua" class="text-gray-900 font-medium">--</span></div>
                <div>操作系统: <span id="os" class="text-gray-900 font-medium">--</span></div>
                <div class="col-span-2">检测时间: <span id="time">--</span></div>
            </div>
        </div>

        <div class="flex gap-4">
            <a href="https://emos.best" class="flex-1 bg-indigo-600 text-white text-center py-3 rounded-xl font-bold shadow-md">访问EMBY服务</a>
            <button onclick="location.reload()" class="flex-1 bg-white border border-gray-200 text-blue-600 py-3 rounded-xl font-bold">重新测试延迟</button>
        </div>
        
        <p class="text-center text-[10px] text-gray-400">© 2026 emos | EMBY反代服务</p>
    </div>

    <script>
        // 1. 增强型设备识别逻辑
        function getDeviceDetail() {
            const ua = navigator.userAgent;
            let os = "未知系统";
            let browser = "未知浏览器";

            // 识别操作系统
            if (/Windows/i.test(ua)) os = "Windows";
            else if (/Macintosh|Mac OS X/i.test(ua)) os = "macOS";
            else if (/Android/i.test(ua)) os = "Android";
            else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
            else if (/Linux/i.test(ua)) os = "Linux";

            // 识别浏览器 (注意顺序，Edge/Chrome 包含 Safari 关键字)
            if (/Edg/i.test(ua)) browser = "Edge";
            else if (/Chrome/i.test(ua) && !/Edg/i.test(ua)) browser = "Chrome";
            else if (/Firefox/i.test(ua)) browser = "Firefox";
            else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) browser = "Safari";
            else if (/MicroMessenger/i.test(ua)) browser = "微信浏览器";

            return { os, browser };
        }

        async function measureLatency() {
            const start = Date.now();
            try {
                await fetch('/ping', { method: 'HEAD', cache: 'no-store' });
                const end = Date.now();
                const diff = end - start;
                document.getElementById('latency').innerText = diff + 'ms';
                
                const tag = document.getElementById('status-tag');
                if(diff < 50) { tag.innerText = '极佳连接质量'; tag.className = 'mt-4 inline-block bg-green-400/40 px-4 py-1 rounded-full text-xs'; }
                else if(diff < 150) { tag.innerText = '连接质量良好'; tag.className = 'mt-4 inline-block bg-yellow-400/40 px-4 py-1 rounded-full text-xs'; }
                else { tag.innerText = '连接稍有延迟'; tag.className = 'mt-4 inline-block bg-red-400/40 px-4 py-1 rounded-full text-xs'; }
            } catch (e) {
                document.getElementById('latency').innerText = '失败';
            }
        }

        // 2. 初始化显示
        const deviceInfo = getDeviceDetail();
        document.getElementById('ua').innerText = deviceInfo.browser;
        document.getElementById('os').innerText = deviceInfo.os;
        document.getElementById('time').innerText = new Date().toLocaleString();

        // 3. 获取 Cloudflare 节点信息
        fetch('/cdn-cgi/trace').then(res => res.text()).then(data => {
            const lines = data.split('\\n');
            const info = {};
            lines.forEach(line => { 
                const [k, v] = line.split('='); 
                if(k) info[k.trim()] = v.trim(); 
            });
            document.getElementById('location').innerText = '中国 (' + (info.loc || '未知') + ')';
            document.getElementById('colo').innerText = info.colo || '未知节点';
        });

        measureLatency();
    </script>
</body>
</html>
`