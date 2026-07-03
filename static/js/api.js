/* Thin API client. Every call unwraps the {ok, data|error} envelope so views
   work with data or a thrown ApiError — the same contract the Android client
   will reuse. */
(function () {
  class ApiError extends Error {
    constructor(code, message) {
      super(message || code);
      this.code = code;
    }
  }

  async function unwrap(res) {
    let body;
    let raw = "";
    try {
      raw = await res.text();
      body = JSON.parse(raw);
    } catch (e) {
      // Non-JSON response (usually a platform/proxy error page). Surface the
      // real status and a snippet so the user/logs show the actual cause.
      const snippet = (raw || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
      throw new ApiError(
        "bad_response",
        `Server error ${res.status} ${res.statusText}${snippet ? ": " + snippet : " (no readable response)"}`
      );
    }
    if (!body.ok) {
      const err = body.error || {};
      throw new ApiError(err.code || "error", err.message || "Request failed.");
    }
    return body.data;
  }

  const json = (method) => async (url, payload) => {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: payload != null ? JSON.stringify(payload) : undefined,
    });
    return unwrap(res);
  };

  window.api = {
    ApiError,
    get: async (url) => unwrap(await fetch(url)),
    post: json("POST"),
    put: json("PUT"),
    del: json("DELETE"),
    // Multipart form (product create, scan frame, restore).
    form: async (url, formData) =>
      unwrap(await fetch(url, { method: "POST", body: formData })),
    imageUrl: (imageId) => `/api/products/image/${imageId}`,
  };
})();
