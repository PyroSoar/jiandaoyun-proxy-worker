const TARGET_HOST = "www.jiandaoyun.com";
const TARGET_ORIGIN = `https://${TARGET_HOST}`;
const PROXY_HOST = "jdy.lzc2002.top";

// optional script injection (replace with your script URL)
const INJECT_SCRIPT = `<script src="https://lab.lzc2002.top/print/jd_print.user.js"></script>`;

class HeadInjector {
  element(element) {
    element.append(INJECT_SCRIPT, { html: true });
  }
}

function rewriteSetCookie(headers) {
  const newHeaders = new Headers();

  for (const [key, value] of headers.entries()) {

    if (key.toLowerCase() === "set-cookie") {

      // rewrite cookie domain
      let cookie = value
        .replace(/domain=\.?jiandaoyun\.com/ig, `domain=.lzc2002.top`)
        .replace(/secure/ig, "Secure"); // normalize

      newHeaders.append("set-cookie", cookie);

    } else {
      newHeaders.set(key, value);
    }
  }

  return newHeaders;
}

export default {

  async fetch(request) {

    const incomingUrl = new URL(request.url);

    console.log(`[proxy] incoming ${request.method} ${incomingUrl.href}`);

    const targetUrl =
      `${TARGET_ORIGIN}${incomingUrl.pathname}${incomingUrl.search}`;

    console.log("[proxy] forward ->", targetUrl);

    // clone original request (keeps method + body)
    const proxyReq = new Request(targetUrl, request);

    // modify headers
    proxyReq.headers.set("host", TARGET_HOST);
    proxyReq.headers.set("origin", TARGET_ORIGIN);
    proxyReq.headers.set("referer", TARGET_ORIGIN + "/");

    // ensure cookies forwarded
    const cookie = request.headers.get("cookie");
    if (cookie) proxyReq.headers.set("cookie", cookie);

    // debug POST body
    if (request.method === "POST") {
      try {
        const clone = request.clone();
        const text = await clone.text();
        console.log("[proxy] POST body sample:", text.slice(0, 200));
      } catch (e) {
        console.log("[proxy] POST body unreadable");
      }
    }

    let resp;

    try {
      resp = await fetch(proxyReq, {
        redirect: "manual"
      });

    } catch (err) {

      console.error("[proxy] fetch error:", err);

      return new Response("Origin fetch failed", {
        status: 502
      });
    }

    console.log(
      "[proxy] origin status:",
      resp.status,
      "content-type:",
      resp.headers.get("content-type")
    );

    // rewrite headers
    const headers = rewriteSetCookie(resp.headers);

    // rewrite redirect
    const location = headers.get("location");
    if (location && location.includes(TARGET_HOST)) {

      const newLocation =
        location.replace(TARGET_ORIGIN, `https://${PROXY_HOST}`);

      headers.set("location", newLocation);

      console.log("[proxy] redirect ->", newLocation);
    }

    // remove CSP so injected script can run
    headers.delete("content-security-policy");
    headers.delete("content-security-policy-report-only");

    const contentType = (headers.get("content-type") || "").toLowerCase();

    // inject script for HTML
    if (contentType.includes("text/html")) {

      return new HTMLRewriter()
        .on("head", new HeadInjector())
        .transform(
          new Response(resp.body, {
            status: resp.status,
            headers
          })
        );
    }

    // non-HTML passthrough
    return new Response(resp.body, {
      status: resp.status,
      headers
    });
  }
};