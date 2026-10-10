class ApiSession {
  constructor(baseUrl) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.cookies = new Map();
  }

  cookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  updateCookies(headers) {
    const setCookie = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [];
    const fallback = headers.get("set-cookie");
    const values = setCookie.length ? setCookie : (fallback ? [fallback] : []);

    for (const cookie of values) {
      const pair = cookie.split(";", 1)[0];
      const eq = pair.indexOf("=");
      if (eq <= 0) {
        continue;
      }

      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name) {
        this.cookies.set(name, value);
      }
    }
  }

  async request(pathname, options = {}) {
    const headers = new Headers(options.headers || {});
    const cookie = this.cookieHeader();
    if (cookie) {
      headers.set("cookie", cookie);
    }

    const response = await fetch(`${this.baseUrl}${pathname}`, {
      ...options,
      headers
    });

    this.updateCookies(response.headers);
    return response;
  }

  async json(pathname, options = {}) {
    const response = await this.request(pathname, options);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status} for ${pathname}: ${body.slice(0, 200)}`);
    }
    return response.json();
  }
}

module.exports = { ApiSession };
