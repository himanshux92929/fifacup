const http = require("http");
const https = require("https");
const url = require("url");
const fs = require("fs");
const path = require("path");

// ── Config (change these freely) ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

const UPSTASH_REDIS_URL    = "https://smiling-mollusk-124402.upstash.io";
const UPSTASH_REDIS_KEY    = "deltaverse:session";
const UPSTASH_TOKEN        = process.env.UPSTASH_REDIS_REST_TOKEN; // only env var

const UPSTREAM_BASE        = "https://pw.deltaverse.site/api/get-video-url";
const CDN_REGEX            = /^https?:\/\/[^/]+\.b-cdn\.net(\/.*)?$/;
const CDN_REPLACEMENT_HOST = "d2kh8g0i619t1c.cloudfront.net";

const UPSTREAM_USER_AGENT  =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const KEYS_FILE = path.join(__dirname, "keys.txt");
// ─────────────────────────────────────────────────────────────────────────────

/** Load keys.txt → { keyvalue: true/false } */
function loadKeys() {
  try {
    const raw = fs.readFileSync(KEYS_FILE, "utf8");
    const keys = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.lastIndexOf("=");
      if (eqIdx === -1) continue;
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim().toLowerCase();
      keys[k] = v === "true";
    }
    return keys;
  } catch (err) {
    console.error("[keys] Failed to read keys.txt:", err.message);
    return {};
  }
}

/** Check key param → { ok, status, error } */
function checkKey(keyParam) {
  if (!keyParam) {
    return { ok: false, status: 401, error: "Access denied. ?key parameter required." };
  }
  const keys = loadKeys();
  if (!(keyParam in keys)) {
    return { ok: false, status: 403, error: "Key not found." };
  }
  if (keys[keyParam] === false) {
    return { ok: false, status: 403, error: "Key expired. Get a new key." };
  }
  return { ok: true };
}

/** Minimal fetch using Node built-in https */
function fetchJson(reqUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(reqUrl);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: opts.method || "GET",
      headers: opts.headers || {},
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: null });
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Pull cookie string from Upstash Redis */
async function getCookieFromRedis() {
  const redisUrl = `${UPSTASH_REDIS_URL}/get/${encodeURIComponent(UPSTASH_REDIS_KEY)}`;
  let status, body;
  try {
    ({ status, body } = await fetchJson(redisUrl, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    }));
  } catch (err) {
    console.error("[redis] Network error fetching session:", err.message);
    throw new Error("redis_network");
  }
  if (status !== 200 || !body?.result) {
    console.error(`[redis] Unexpected response: status=${status} result=${body?.result ?? "null"}`);
    throw new Error("redis_miss");
  }
  const session = JSON.parse(body.result);
  const cookieLines = session.cookies.split("\n").map((l) => l.trim()).filter(Boolean);
  const cookiePairs = cookieLines.map((line) => line.split(";")[0].trim());
  return cookiePairs.join("; ");
}

/** Rewrite b-cdn.net URLs to CloudFront */
function rewriteCdn(manifestUrl) {
  if (!manifestUrl || !CDN_REGEX.test(manifestUrl)) return manifestUrl;
  try {
    const parsed = new url.URL(manifestUrl);
    parsed.hostname = CDN_REPLACEMENT_HOST;
    return parsed.toString();
  } catch (err) {
    console.error("[cdn] Failed to rewrite manifest URL:", err.message);
    return manifestUrl;
  }
}

/** Handle GET /video-url */
async function handleVideoUrl(reqUrl, res) {
  const params    = new url.URL(reqUrl, "http://localhost").searchParams;
  const keyParam  = params.get("key");
  const batchId   = params.get("batchId");
  const childId   = params.get("childId");
  const subjectId = params.get("subjectId");

  // 0. Key check
  const auth = checkKey(keyParam);
  if (!auth.ok) {
    res.writeHead(auth.status, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: auth.error }));
  }

  // 1. Validate required params
  if (!batchId || !childId || !subjectId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Missing required parameters", error_id: "MISSING_PARAMS" }));
  }

  // 2. Get cookie from Redis
  let cookie;
  try {
    cookie = await getCookieFromRedis();
  } catch (err) {
    console.error("[video-url] Failed to get cookie from Redis:", err.message);
    res.writeHead(502, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Could not retrieve session", error_id: "SESSION_ERROR" }));
  }

  // 3. Build upstream URL
  const upstreamUrl = new url.URL(UPSTREAM_BASE);
  upstreamUrl.searchParams.set("batchId",   batchId);
  upstreamUrl.searchParams.set("childId",   childId);
  upstreamUrl.searchParams.set("subjectId", subjectId);

  // 4. Fetch from upstream
  let upstream;
  try {
    upstream = await fetchJson(upstreamUrl.toString(), {
      headers: {
        Accept:       "application/json",
        "User-Agent": UPSTREAM_USER_AGENT,
        Cookie:       cookie,
      },
    });
  } catch (err) {
    console.error("[video-url] Upstream fetch failed:", err.message);
    res.writeHead(502, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Upstream unreachable", error_id: "UPSTREAM_UNREACHABLE" }));
  }

  if (upstream.status !== 200 || !upstream.body) {
    console.error(`[video-url] Upstream non-200: status=${upstream.status} body=${JSON.stringify(upstream.body)}`);
    res.writeHead(502, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Upstream error", error_id: "UPSTREAM_ERROR" }));
  }

  const body = upstream.body;
  if (body?.success === false) {
    console.error("[video-url] Upstream success=false:", JSON.stringify(body));
    res.writeHead(502, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Upstream failure", error_id: "UPSTREAM_FAILURE" }));
  }

  // 5. Extract & rewrite fields
  const data = body?.data ?? {};
  const result = {
    manifest_url:    rewriteCdn(typeof data.manifest_url    === "string"  ? data.manifest_url    : null),
    video_container: typeof data.video_container === "string"  ? data.video_container : null,
    drm_protected:   typeof data.drm_protected   === "boolean" ? data.drm_protected   : null,
    kid:             typeof data.kid             === "string"  ? data.kid             : null,
    key:             typeof data.key             === "string"  ? data.key             : null,
  };

  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(result));
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const pathname = new url.URL(req.url, "http://localhost").pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // GET /
  if (req.method === "GET" && pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(`<!DOCTYPE html><html><body style="margin:0;background:#ff0000;color:#000000;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;font-size:2rem;font-weight:bold;">why are u here bro?</body></html>`);
  }

  // GET /video-url
  if (req.method === "GET" && pathname === "/video-url") {
    return handleVideoUrl(req.url, res).catch((err) => {
      console.error("[video-url] Unhandled error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error", error_id: "INTERNAL_ERROR" }));
    });
  }

  // GET /health
  if (req.method === "GET" && pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => console.log(`[server] Running on port ${PORT}`));
