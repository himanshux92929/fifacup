const http = require("http");
const https = require("https");
const url = require("url");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ── Config (change these freely) ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

const UPSTASH_REDIS_URL    = "https://smiling-mollusk-124402.upstash.io";
const UPSTASH_REDIS_KEY    = "deltaverse:session";
const UPSTASH_TOKEN        = process.env.UPSTASH_REDIS_REST_TOKEN; // only env var

const UPSTREAM_BASE        = "https://pw.deltaverse.site/api/get-video-url";
const CDN_REGEX            = /^https?:\/\/[^/]+\.b-cdn\.net(\/.*)?$/;
const CDN_REPLACEMENT_HOST = "d1d34p8vz63oiq.cloudfront.net";

const UPSTREAM_USER_AGENT  =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const STATIC_COOKIES = [
  "dv=8a9cf7c9-6542-4ce5-90ac-d47966e26794",
  "accessToken=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI2YWI1NjMxZDRiMzE3ZjEyNjk1ZWQyMDQiLCJuYW1lIjoiRGVsdGFWZXJzZSBVc2VyIDUwMTM3NzM0IiwidGVsZWdyYW1JZCI6bnVsbCwiUGhvdG9VcmwiOm51bGwsImlzR3Vlc3QiOnRydWUsImRldmljZUlkIjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWIiLCJpcCI6IjEwMy42Mi45Mi4yMzUiLCJpYXQiOjE3OTAyNzIyODYsImV4cCI6MTc5MTU2ODI4Nn0.rZPGiCcjulSESYkzGQDZ5D5i6pPTTZGlpe_lK5jtanM",
  "refreshToken=77284432fabd91fe43ac77e4b58f521fce6479ed0e531d4efe13d7de3fbcddbf",
];

const KEYS_FILE = path.join(__dirname, "keys.txt");

// ── vidcloud constants (fixed for all /video-urlx requests) ──────────────────
const VIDCLOUD_BASE  = "https://vidcloud.eu.org/play.php";
const VIDCLOUD_TYPE_ID    = "6a89711fb1fa93c66f96a3e9";
const VIDCLOUD_VIDEO_TYPE = "new";

// AES-CBC key/IV matching the HTML decryptor tool
const AES_KEY = Buffer.from("R7@kP4#xL9!mQ2$v", "utf8"); // 16 bytes → AES-128
const AES_IV  = Buffer.from("T3!nW8$qZ5@rK1#p", "utf8"); // 16 bytes
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

/** Minimal fetch using Node built-in https — returns raw text body */
function fetchText(reqUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(reqUrl);
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname + parsed.search,
      method:   opts.method || "GET",
      headers:  opts.headers || {},
    };
    const req = https.request(options, (res) => {
      // Follow redirects (301/302/307/308) up to 5 hops
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && (opts._redirects || 0) < 5) {
        const nextUrl = new url.URL(res.headers.location, reqUrl).toString();
        return resolve(fetchText(nextUrl, { ...opts, _redirects: (opts._redirects || 0) + 1 }));
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Minimal fetch using Node built-in https — returns parsed JSON body */
function fetchJson(reqUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(reqUrl);
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname + parsed.search,
      method:   opts.method || "GET",
      headers:  opts.headers || {},
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
  const redisPairs = cookieLines.map((line) => line.split(";")[0].trim());
  return [...STATIC_COOKIES, ...redisPairs].join("; ");
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

/**
 * Decrypt AES-128-CBC base64 string using the shared key/IV.
 * Returns the plaintext string, or the original value on failure (non-empty input).
 * Returns "" for empty/null input.
 */
function decryptAES(ciphertextBase64) {
  if (!ciphertextBase64 || typeof ciphertextBase64 !== "string" || !ciphertextBase64.trim()) {
    return "";
  }
  try {
    const cipherBuf = Buffer.from(ciphertextBase64.trim(), "base64");
    const decipher  = crypto.createDecipheriv("aes-128-cbc", AES_KEY, AES_IV);
    const decrypted = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (err) {
    console.error("[aes] Decryption failed:", err.message);
    return ciphertextBase64; // return raw on failure, same as the browser tool
  }
}

/**
 * Parse hidden <input> fields from an HTML string.
 * Returns { id: value, ... } for every <input type="hidden" id="..." value="...">.
 * Handles HTML-encoded quotes (&quot;) in value attributes.
 */
function parseHiddenInputs(html) {
  const result = {};
  // Match <input ... > tags (self-closing or not)
  const tagRe = /<input\b([^>]*?)(?:\/>|>)/gi;
  let tagMatch;
  while ((tagMatch = tagRe.exec(html)) !== null) {
    const attrs = tagMatch[1];

    // Only process type="hidden"
    const typeMatch = /\btype\s*=\s*["']([^"']*)["']/i.exec(attrs);
    if (!typeMatch || typeMatch[1].toLowerCase() !== "hidden") continue;

    // Extract id
    const idMatch = /\bid\s*=\s*["']([^"']*)["']/i.exec(attrs);
    if (!idMatch || !idMatch[1]) continue;
    const id = idMatch[1];

    // Extract value — supports both " and ' delimiters, and &quot; inside
    let value = "";
    const valMatch = /\bvalue\s*=\s*(["'])([\s\S]*?)\1/i.exec(attrs);
    if (valMatch) {
      value = valMatch[2]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#39;/g, "'");
    }

    result[id] = value;
  }
  return result;
}

/**
 * Build the final JSON object from parsed hidden inputs,
 * mirroring the logic of the HTML decryptor tool exactly.
 */
function buildResultFromInputs(inputs) {
  const obj = {};
  for (const [id, value] of Object.entries(inputs)) {
    if (id === "attachments_data") {
      try {
        obj[id] = JSON.parse(value);
      } catch {
        obj[id] = value;
      }
    } else if (id.startsWith("enc_")) {
      const cleanKey = id.replace(/^enc_/, "");
      obj[cleanKey] = decryptAES(value);
    } else {
      obj[id] = value;
    }
  }
  return obj;
}

// ── Handle GET /video-url ─────────────────────────────────────────────────────
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

// ── Handle GET /video-urlx ────────────────────────────────────────────────────
async function handleVideoUrlX(reqUrl, res) {
  const t0     = Date.now();
  const params = new url.URL(reqUrl, "http://localhost").searchParams;
  const keyParam  = params.get("key");
  const batchId   = params.get("batchId");
  const subjectId = params.get("subjectId");
  const videoId   = params.get("videoId");

  // 0. Key check
  const auth = checkKey(keyParam);
  if (!auth.ok) {
    res.writeHead(auth.status, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: auth.error }));
  }

  // 1. Validate required params
  if (!batchId || !subjectId || !videoId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      error:    "Missing required parameters: batchId, subjectId, videoId",
      error_id: "MISSING_PARAMS",
    }));
  }

  // 2. Build vidcloud URL (typeId and video_type are constant)
  const vidcloudUrl = new url.URL(VIDCLOUD_BASE);
  vidcloudUrl.searchParams.set("batch_id",   batchId);
  vidcloudUrl.searchParams.set("subject_id", subjectId);
  vidcloudUrl.searchParams.set("video_id",   videoId);
  vidcloudUrl.searchParams.set("typeId",     VIDCLOUD_TYPE_ID);
  vidcloudUrl.searchParams.set("video_type", VIDCLOUD_VIDEO_TYPE);

  console.log(`[video-urlx] Fetching: ${vidcloudUrl.toString()}`);

  // 3. Fetch the HTML page from vidcloud
  let pageRes;
  try {
    pageRes = await fetchText(vidcloudUrl.toString(), {
      headers: {
        "User-Agent": UPSTREAM_USER_AGENT,
        "Accept":     "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer":    "https://vidcloud.eu.org/",
      },
    });
  } catch (err) {
    console.error("[video-urlx] Fetch failed:", err.message);
    res.writeHead(502, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Could not reach vidcloud", error_id: "UPSTREAM_UNREACHABLE" }));
  }

  if (pageRes.status !== 200) {
    console.error(`[video-urlx] Non-200 from vidcloud: status=${pageRes.status}`);
    res.writeHead(502, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      error:    `Vidcloud returned HTTP ${pageRes.status}`,
      error_id: "UPSTREAM_ERROR",
    }));
  }

  const html = pageRes.text;

  // 4. Sanity-check: ensure there are hidden inputs in the page
  if (!html.includes('type="hidden"') && !html.includes("type='hidden'")) {
    console.error("[video-urlx] No hidden inputs found in page. Possible auth/redirect issue.");
    res.writeHead(502, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      error:    "Vidcloud page did not contain expected hidden fields",
      error_id: "PARSE_ERROR",
    }));
  }

  // 5. Parse hidden inputs & build result (same logic as HTML decryptor tool)
  const inputs = parseHiddenInputs(html);
  const parsed = buildResultFromInputs(inputs);

  const timeTakenMs = Date.now() - t0;

  // 6. Return final JSON
  const responseObj = {
    ...parsed,
    time_taken_ms: timeTakenMs,
  };

  console.log(`[video-urlx] Done in ${timeTakenMs}ms — fields: ${Object.keys(parsed).join(", ")}`);

  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(responseObj));
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

  // GET /video-urlx  ← NEW
  if (req.method === "GET" && pathname === "/video-urlx") {
    return handleVideoUrlX(req.url, res).catch((err) => {
      console.error("[video-urlx] Unhandled error:", err);
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
