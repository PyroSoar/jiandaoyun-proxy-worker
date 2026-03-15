const TARGET_HOST = "www.jiandaoyun.com";
const TARGET_ORIGIN = `https://${TARGET_HOST}`;
// 把你想注入的脚本改成你实际托管的地址，或直接写内联 JS
const INJECT_SCRIPT_TAG = `<script src="https://static.lzc2002.top/tm/jiandaoyun.js"></script>`;

class HeadInjector {
  element(element) {
    // 在 head 的末尾追加你的脚本
    element.append(INJECT_SCRIPT_TAG, { html: true });
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      const incomingUrl = new URL(request.url);
      // 构造目标 URL（保持 path + query）
      const targetUrl = `${TARGET_ORIGIN}${incomingUrl.pathname}${incomingUrl.search}`;

      // 复制并修改请求头（尽量模拟原站请求）
      const reqHeaders = new Headers(request.headers);
      reqHeaders.set("host", TARGET_HOST);
      // 可根据需要设置 origin / referer；若不想改可注释
      reqHeaders.set("origin", TARGET_ORIGIN);
      reqHeaders.set("referer", TARGET_ORIGIN + "/");

      const proxyReq = new Request(targetUrl, {
        method: request.method,
        headers: reqHeaders,
        body: request.body,
        redirect: "manual"
      });

      const resp = await fetch(proxyReq);

      // 复制响应 headers，稍后会返回给客户端
      const newHeaders = new Headers(resp.headers);

      // 1) rewrite Location 头（重定向目标）
      const location = newHeaders.get("location");
      if (location) {
        // 把指向真实站点的重定向改为当前访问域
        try {
          const fixed = location.replace(TARGET_ORIGIN, `${incomingUrl.protocol}//${incomingUrl.host}`);
          newHeaders.set("location", fixed);
        } catch (e) {
          // 无动作
        }
      }

      // 2) 如果需要在页面里注入脚本，删除 CSP；如果你依然想保留 CSP，那就不要删除
      newHeaders.delete("content-security-policy");
      newHeaders.delete("content-security-policy-report-only");
      // 有些站点会设置 x-frame-options，按需删除或保留
      newHeaders.delete("x-frame-options");

      // 3) content-type 判断
      const contentType = (newHeaders.get("content-type") || "").toLowerCase();

      // 如果是 HTML，使用 HTMLRewriter 注入脚本并保留响应流（不会把整个页面读到内存）
      if (contentType.includes("text/html")) {
        const transformed = new HTMLRewriter()
          .on("head", new HeadInjector())
          .transform(new Response(resp.body, {
            status: resp.status,
            headers: newHeaders
          }));
        return transformed;
      }

      // 非 HTML，原样返回流（状态码与头都保留）
      return new Response(resp.body, {
        status: resp.status,
        headers: newHeaders
      });

    } catch (err) {
      // 调试时返回错误详情（生产可简化）
      return new Response(`Worker error: ${err.message}`, { status: 502 });
    }
  }
};