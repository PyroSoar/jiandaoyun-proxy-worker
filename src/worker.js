// src/worker.js
const TARGET_HOST = "www.jiandaoyun.com";
const TARGET_ORIGIN = `https://${TARGET_HOST}`;
// script to inject (optional). Keep small while debugging.
const INJECT_SCRIPT_TAG = `<script>console.log('injected tm replacement');</script>`;

// ms
const ORIGIN_FETCH_TIMEOUT = 15000;

class HeadInjector {
  element(element) {
    element.append(INJECT_SCRIPT_TAG, { html: true });
  }
}

function headersToObject(headers) {
  const obj = {};
  for (const [k, v] of headers.entries()) obj[k] = v;
  return obj;
}

export default {
  async fetch(request, env, ctx) {
    const incomingUrl = new URL(request.url);
    const path = incomingUrl.pathname || "/";
    const isHealth = path === "/__health";
    const isDebug = incomingUrl.searchParams.has("__debug") || request.headers.get("x-proxy-debug") === "1";

    // Always log arrival (helps confirm worker is invoked)
    console.log(`[proxy] incoming ${request.method} ${incomingUrl.href}`);

    // Health endpoint: quick check
    if (isHealth) {
      console.log("[proxy] health check");
      return new Response(JSON.stringify({
        ok: true,
        timestamp: new Date().toISOString(),
        worker: true
      }, null, 2), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }

    // Prepare target URL
    const targetUrl = `${TARGET_ORIGIN}${incomingUrl.pathname}${incomingUrl.search}`;

    // Build proxied request headers (clone then tweak)
    const reqHeaders = new Headers(request.headers);
    reqHeaders.set("host", TARGET_HOST);
    // if the origin server checks origin/referer, present as if request came from real site
    reqHeaders.set("origin", TARGET_ORIGIN);
    reqHeaders.set("referer", TARGET_ORIGIN + "/");

    // For logging
    const reqHeaderObj = headersToObject(reqHeaders);
    console.log("[proxy] forwarding to targetUrl:", targetUrl);
    console.log("[proxy] request headers (sample):", JSON.stringify(
      { host: reqHeaderObj.host, referer: reqHeaderObj.referer, origin: reqHeaderObj.origin }, null, 2));

    // Setup timeout for origin fetch
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, ORIGIN_FETCH_TIMEOUT);

    let resp;
    let fetchError = null;
    const start = Date.now();
    try {
      const proxyReq = new Request(targetUrl, {
        method: request.method,
        headers: reqHeaders,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
        signal: controller.signal
      });

      resp = await fetch(proxyReq);
    } catch (err) {
      fetchError = err;
      console.error("[proxy] fetch error:", err && err.message ? err.message : String(err));
    } finally {
      clearTimeout(timeout);
    }
    const took = Date.now() - start;
    console.log(`[proxy] origin fetch took ${took}ms`);

    // If origin fetch errored, return a helpful debug page (so browser doesn't show "closed connection")
    if (!resp) {
      const body = {
        error: "origin_fetch_failed",
        message: fetchError ? (fetchError.message || String(fetchError)) : "unknown error",
        targetUrl,
        timestamp: new Date().toISOString()
      };
      // If debug requested, return JSON; otherwise return a user-friendly HTML with instructions
      if (isDebug) {
        return new Response(JSON.stringify(body, null, 2), { status: 502, headers: { "content-type": "application/json; charset=utf-8" }});
      } else {
        const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Proxy error</title></head><body>
<h2>Proxy: failed to fetch origin</h2>
<pre>${escapeHtml(body.message)}</pre>
<p>See worker logs (wrangler tail) for details.</p>
</body></html>`;
        return new Response(html, { status: 502, headers: { "content-type": "text/html; charset=utf-8" }});
      }
    }

    // We have a response from origin — replicate headers and status
    const newHeaders = new Headers(resp.headers);

    // Rewrite Location headers that point to TARGET_HOST -> current host
    const location = newHeaders.get("location");
    if (location && location.includes(TARGET_HOST)) {
      try {
        const fixed = location.replace(TARGET_ORIGIN, `${incomingUrl.protocol}//${incomingUrl.host}`);
        newHeaders.set("location", fixed);
        console.log("[proxy] rewrote location header:", fixed);
      } catch (e) {
        console.warn("[proxy] failed to rewrite location:", e);
      }
    }

    // Remove CSP so injected script can run (comment out if you want to keep CSP)
    newHeaders.delete("content-security-policy");
    newHeaders.delete("content-security-policy-report-only");
    // Optionally remove x-frame-options if you embed etc
    newHeaders.delete("x-frame-options");

    // Log response summary
    console.log("[proxy] origin status:", resp.status, "content-type:", newHeaders.get("content-type"));

    // If client asked for debug JSON, produce rich debug info (reads body)
    if (isDebug) {
      let respText = "";
      try {
        respText = await resp.text(); // we consume body in debug mode
      } catch (e) {
        respText = `<unable to read body: ${e && e.message ? e.message : String(e)}>`;
      }
      const debugObj = {
        incoming: {
          url: incomingUrl.href,
          method: request.method,
          headers: headersToObject(request.headers)
        },
        forwarded: {
          targetUrl,
          method: request.method,
          headers: reqHeaderObj
        },
        originResponse: {
          status: resp.status,
          headers: headersToObject(newHeaders),
          body_sample: respText.slice(0, 8192) // only show first chunk
        },
        timing: { took_ms: took }
      };
      return new Response(JSON.stringify(debugObj, null, 2), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }

    // For HTML responses, inject a small marker script using HTMLRewriter (streaming)
    const contentType = (newHeaders.get("content-type") || "").toLowerCase();
    if (contentType.includes("text/html")) {
      // streaming transform keeps memory small
      const transformed = new HTMLRewriter()
        .on("head", new HeadInjector())
        .transform(new Response(resp.body, { status: resp.status, headers: newHeaders }));
      return transformed;
    }

    // Non-HTML: passthrough stream (preserve status & headers)
    return new Response(resp.body, { status: resp.status, headers: newHeaders });
  }
};

// small helper
function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}