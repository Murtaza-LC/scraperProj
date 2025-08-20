// netlify/functions/scrape.js
// Amazon single-category (or custom URL) scraper for Netlify Functions (Puppeteer + @sparticuz/chromium)
// - No global "hard limit": each invocation handles exactly ONE category or ONE custom URL
// - Tunables: timeout_ms (per-page), max_pages, per_list_limit
// - Extracts price, MRP, % off, rating, review_count, "bought in past month"

const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

/* ---------- Presets (Amazon India) ---------- */
const PRESETS = {
  mobiles: "https://www.amazon.in/s?k=trending+mobile+phones",
  mobile_accessories: "https://www.amazon.in/s?k=trending+mobile+phone+accessories",
  laptops: "https://www.amazon.in/s?k=trending+laptops",
  laptop_accessories: "https://www.amazon.in/s?k=trending+laptop+accessories",
};

/* ---------- Defaults ---------- */
const DEFAULT_TIMEOUT_MS = 12000; // per page (goto + selector)
const DEFAULT_MAX_PAGES = 2;      // 1–3 recommended
const DEFAULT_PER_LIST = 16;      // items kept from listing

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

/* ---------- Tiny utils ---------- */
const resp = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(body),
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pageWithParam = (url, n) => (n <= 1 ? url : `${url}${url.includes("?") ? "&" : "?"}page=${n}`);

function makeDebugger(on) {
  const lines = [];
  const d = (msg, extra) => { const L = `[${new Date().toISOString()}] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`; console.log(L); lines.push(L); };
  return { d, dump: () => (on ? lines : undefined) };
}

function normalizeUrl(u) {
  if (!u) return null;
  u = String(u).trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u.replace(/^\/+/, "");
  try { const parsed = new URL(u); if (!parsed.host.toLowerCase().includes("amazon.")) return null; return parsed.toString(); }
  catch { return null; }
}

const money = (t) => { if (!t) return null; const m = String(t).match(/[₹]?\s*([\d,]+\.?\d*)/); return m ? Number(m[1].replace(/,/g,"")) : null; };
const pctOff = (mrp, price)=> (mrp && price && mrp>0 && price<=mrp) ? Math.round((100*(mrp-price)/mrp)*10)/10 : null;
const BRAND_SET = new Set(["samsung","apple","xiaomi","oneplus","realme","vivo","oppo","iqoo","motorola","tecno","infinix","lava","nokia","honor","google","acer","poco","dell","hp","lenovo","asus","msi"]);
const BRAND_MAP = { iphone:"Apple", mi:"Xiaomi", redmi:"Xiaomi", moto:"Motorola", poco:"Poco" };
function brandGuess(name) {
  if (!name) return null;
  for (const raw of name.split(/\s+/).slice(0,5)) {
    const t = raw.replace(/[^A-Za-z0-9+]/g,"").toLowerCase();
    if (BRAND_MAP[t]) return BRAND_MAP[t];
    if (BRAND_SET.has(t)) return t[0].toUpperCase()+t.slice(1);
  }
  return null;
}
function parseBought(text){
  if(!text) return null;
  const s = text.toLowerCase();
  if (!/bought in past month/.test(s)) return null;
  const mK = s.match(/([\d,.]+)\s*k\+?/); // 10k+
  if (mK) { const base = Number(mK[1].replace(/,/g,'')); return isFinite(base) ? Math.round(base*1000) : null; }
  const mPlus = s.match(/([\d,.]+)\s*\+/); // 800+
  if (mPlus) { const n = Number(mPlus[1].replace(/,/g,'')); return isFinite(n) ? n : null; }
  const mPlain = s.match(/([\d,.]+)\s*bought/); // 500 bought
  if (mPlain) { const n = Number(mPlain[1].replace(/,/g,'')); return isFinite(n) ? n : null; }
  return null;
}

/* ---------- Puppeteer hygiene ---------- */
async function hardenPage(page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "languages", { get: () => ["en-IN","en"] });
    Object.defineProperty(navigator, "platform", { get: () => "Win32" });
    window.chrome = { runtime: {} };
  });
  await page.setViewport({ width: 1360, height: 900, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const t = req.resourceType();
    if (t === "image" || t === "media" || t === "font") return req.abort();
    req.continue();
  });
}

async function gotoWithRetries(page, url, readySel, timeoutMs, dbg) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      dbg.d("goto attempt", { attempt: attempt+1, url });
      await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
      const title = await page.title().catch(()=> "");
      dbg.d("after goto", { title, cur: page.url() });
      await page.waitForSelector(readySel, { timeout: timeoutMs });
      dbg.d("selector appeared", { readySel });
      return { ok:true };
    } catch (e) {
      dbg.d("goto/wait error", { attempt, err: String(e) });
      if (attempt === 1) return { ok:false };
      await sleep(300);
    }
  }
  return { ok:false };
}

/* ---------- Extraction ---------- */
async function extractAmazonList(page, sourceUrl, listOffset, timeoutMs, limit, dbg, category) {
  const out = [];
  try { await page.waitForSelector("div.s-main-slot", { timeout: timeoutMs }); }
  catch { dbg.d("amazon: s-main-slot not found"); return [out, listOffset]; }

  const cards = await page.$$("div.s-main-slot div.s-result-item[data-component-type='s-search-result']");
  dbg.d("amazon: cards", { n: cards.length, category });
  let pos = listOffset;

  for (const c of cards) {
    try {
      const titleEl = await c.$("h2 a span.a-size-medium") || await c.$("h2 a span") || await c.$("h2");
      let name = titleEl ? (await page.evaluate(el => el.textContent, titleEl))?.trim() : null;

      const linkEl = await c.$("h2 a");
      const href = linkEl ? await page.evaluate(el => el.getAttribute("href"), linkEl) : null;
      if (!name && linkEl) name = (await page.evaluate(el => el.getAttribute("aria-label"), linkEl)) || null;

      const asin = await page.evaluate(el => el.getAttribute("data-asin"), c);
      const product_url = href ? new URL(href, "https://www.amazon.in").toString()
                               : (asin ? `https://www.amazon.in/dp/${asin}` : null);

      const imgEl = await c.$("img.s-image");
      const image_url = imgEl ? await page.evaluate(el => el.getAttribute("src"), imgEl) : null;

      const priceEl = await c.$("span.a-price:not(.a-text-price) span.a-offscreen");
      const price = money(priceEl ? await page.evaluate(el => el.textContent, priceEl) : null);
      const mrpEl = await c.$("span.a-text-price span.a-offscreen");
      const mrp = money(mrpEl ? await page.evaluate(el => el.textContent, mrpEl) : null);

      // rating + reviews
      let rating = null, review_count = null;
      const ratingEl = await c.$("span.a-icon-alt");
      if (ratingEl) {
        const t = (await page.evaluate(el => el.textContent, ratingEl)) || "";
        const m = t.match(/([\d.]+)\s+out of 5/);
        if (m) { const v = Number(m[1]); if (isFinite(v)) rating = v; }
      }
      const reviewsEl = await c.$("span[aria-label$='ratings'], span.a-size-base.s-underline-text");
      if (reviewsEl) {
        const t = (await page.evaluate(el => el.textContent, reviewsEl)) || "";
        const m = t.match(/([\d,]+)/);
        if (m) { const n = Number(m[1].replace(/,/g,'')); if (isFinite(n)) review_count = n; }
      }

      // "bought in past month" (broad text scan inside card)
      const cardText = await page.evaluate(node => node.innerText, c).catch(()=>null);
      const bought_past_month = parseBought(cardText);

      if (name || price || product_url) {
        pos++;
        out.push({
          date: new Date().toISOString().slice(0,10),
          timestamp: new Date().toISOString(),
          platform: "amazon",
          category,
          list_position: pos,
          product_name: name,
          brand_guess: brandGuess(name),
          price, mrp, discount_percent: pctOff(mrp, price),
          rating, review_count,
          bought_past_month,
          product_url, image_url, source_url: sourceUrl,
        });
        if (out.length >= limit) break;
      }
    } catch (e) {
      dbg.d("amazon: card parse error", { err: String(e), category });
    }
  }
  dbg.d("amazon: extracted", { n: out.length, category });
  return [out, pos];
}

/* ---------- Handler ---------- */
module.exports.handler = async function (event) {
  const qs = event.queryStringParameters || {};
  const debugEnabled = String(qs.debug || "0") === "1";
  const shotEnabled  = String(qs.debug_shot || "0") === "1";
  const DBG = makeDebugger(debugEnabled);

  try {
    // Either category (one of PRESETS) or amazon_url must be present
    const category = (qs.category || "").toLowerCase();
    const customUrl = normalizeUrl(qs.amazon_url);
    const url = customUrl || PRESETS[category];

    if (!url) {
      return resp(400, { ok:false, error:"Provide ?category=mobiles|mobile_accessories|laptops|laptop_accessories or a valid ?amazon_url=…" });
    }

    const timeoutMs   = Math.max(3000, parseInt(qs.timeout_ms || DEFAULT_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS);
    const maxPages    = Math.max(1, Math.min(3, parseInt(qs.max_pages || DEFAULT_MAX_PAGES, 10) || DEFAULT_MAX_PAGES));
    const perList     = Math.max(1, Math.min(60, parseInt(qs.per_list_limit || DEFAULT_PER_LIST, 10) || DEFAULT_PER_LIST));

    DBG.d("params", { category: category || 'custom', url, timeoutMs, maxPages, perList });

    // Launch Chromium
    const executablePath = await chromium.executablePath();
    DBG.d("chromium path", { executablePath });
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await hardenPage(page);
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({
      "accept-language": "en-IN,en;q=0.9",
      "upgrade-insecure-requests": "1",
      "sec-fetch-mode": "navigate",
      "referer": "https://www.google.com/",
    });

    const rows = [];
    let pos = 0;
    let shotBase64 = null;

    for (let p=1; p<=maxPages; p++) {
      const pageUrl = pageWithParam(url, p);
      const nav = await gotoWithRetries(page, pageUrl, "div.s-main-slot", timeoutMs, DBG);
      if (!nav.ok) break;

      if (shotEnabled && !shotBase64) {
        shotBase64 = await page.screenshot({ type:"jpeg", quality:40, encoding:"base64" }).catch(()=>null);
      }

      await sleep(120); // brief settle
      const [chunk, newPos] = await extractAmazonList(page, url, pos, timeoutMs, perList, DBG, category || 'custom');
      pos = newPos; rows.push(...chunk);

      if (chunk.length < 3) break; // heuristic early stop if sparse
      if (rows.length >= perList) break;
    }

    await browser.close();

    // de-dup by product_url
    const seen = new Set(); const uniq = [];
    for (const r of rows) { if (!r.product_url || seen.has(r.product_url)) continue; seen.add(r.product_url); uniq.push(r); }

    const payload = { ok:true, count: uniq.length, rows: uniq };
    const dbg = DBG.dump();
    if (dbg) payload.debug = dbg;
    if (shotEnabled && shotBase64) payload.debug_screenshot = `data:image/jpeg;base64,${shotBase64}`;
    return resp(200, payload);
  } catch (err) {
    console.error("Function error:", err);
    return resp(500, { ok:false, error: String((err && err.message) || err) });
  }
};
