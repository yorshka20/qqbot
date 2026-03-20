// Cloudflare Worker: 火山引擎 API 反代
// 部署后将 bot 的 base_url 从 https://ark.cn-beijing.volces.com 改为你的 Worker URL

const TARGET = 'https://ark.cn-beijing.volces.com';

export default {
  async fetch(request, env) {
    // 只允许 POST（火山引擎 API 都是 POST）
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    // 可选：简单鉴权，防止被滥用
    // 如果设置了 env.PROXY_SECRET，则要求请求头带 X-Proxy-Secret
    if (env.PROXY_SECRET) {
      const secret = request.headers.get('X-Proxy-Secret');
      if (secret !== env.PROXY_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    // 构建目标 URL：保留原始 path 和 query
    const url = new URL(request.url);
    const targetUrl = TARGET + url.pathname + url.search;

    // 转发请求，保留原始 headers（去掉 host 和自定义鉴权头）
    const headers = new Headers(request.headers);
    headers.delete('Host');
    headers.delete('X-Proxy-Secret');

    try {
      const response = await fetch(targetUrl, {
        method: request.method,
        headers,
        body: request.body,
      });

      // 对于 SSE 流式响应，直接透传
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('Access-Control-Allow-Origin', '*');

      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
    } catch (err) {
      return Response.json({ error: 'proxy_error', message: err.message }, { status: 502 });
    }
  },
};
