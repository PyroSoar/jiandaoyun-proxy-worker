const TARGET = "https://www.jiandaoyun.com";

export default {
  async fetch(request) {

    const url = new URL(request.url);

    // Forward to Jiandaoyun
    const targetUrl = TARGET + url.pathname + url.search;

    const newHeaders = new Headers(request.headers);

    newHeaders.set("host", "www.jiandaoyun.com");
    newHeaders.set("origin", TARGET);
    newHeaders.set("referer", TARGET);

    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      headers: newHeaders,
      body: request.body,
      redirect: "manual"
    });

    const response = await fetch(proxyRequest);

    const headers = new Headers(response.headers);

    // Remove headers that break proxying
    headers.delete("content-security-policy");
    headers.delete("content-security-policy-report-only");
    headers.delete("x-frame-options");

    // If HTML, inject script
    const contentType = headers.get("content-type") || "";

    if (contentType.includes("text/html")) {

      let text = await response.text();

      const injectScript = `
<script src="https://lab.lzc2002.top/print/jd_print.user.js"></script>
`;

      text = text.replace("</head>", injectScript + "</head>");

      return new Response(text, {
        status: response.status,
        headers
      });

    }

    // Otherwise pass through
    return new Response(response.body, {
      status: response.status,
      headers
    });

  }
};