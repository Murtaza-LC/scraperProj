// netlify/functions/scrape.js
// Amazon-only multi-category listing scraper for Netlify Functions (Puppeteer + @sparticuz/chromium)
// - Scrapes 4 preset categories (or a single custom amazon_url)
// - Collects price/MRP/discount + rating + review_count + "bought in past month" + badges
// - Enforces per-category time budgets so all 4 categories get processed

const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

/* ---------------- Presets ---------------- */
const PRESETS = [
  { cat: "mobiles",             url: "https://www.amazon.in/s?k=trending+mobile+phones" },
  { cat: "mobile_accessories",  url: "https://www.amazon.in/s?k=trending+mobile+phone+accessories" },
  { cat: "laptops",             url: "https://www.amazon.in/s?k=trending+laptops" },
  { cat: "laptop_accessories",  url: "https://www.amazon.in/s?k=trending+laptop+accessories" },
];

/* ---------------- Defaults (can be overridden via query params) ---------------- */
const DEFAULT_TIMEOUT_MS   = 12000;  // page waitForSelector / goto timeout
const DEFAULT_HARD_LIMIT_MS= 25000;  // total function budget (soft cap)
const DEFAULT_SCROLL_STEPS = 2;
const DEFAULT_SCROLL_PAUSE = 140;
const DEFAULT_MIN_WAIT     = 100;
const DEFAULT_MAX_WAIT     = 220;
const DEFAULT_PER_LIST     = 16;     // items per category
const DEFAULT_MAX_PAGES    = 2;

const UA_DESKTOPS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
];

/* ---------------- Utilities ---------------- */
const resp = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(body),
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rnd = (min,max)=> Math.floor(Math.random()*(max-min+1))+min;
const randWait = (min,max)=> sleep(rnd(min,max));
const now = ()=> Date.now();
const timeLeft = (deadline)=> Math.max(0, deadline - now());

function makeDebugger(on) {
  const lines = [];
  const d = (msg, extra) => {
    const L = `[${new Date().toISOString()}] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`;
    console.log(L); lines.push(L);
  };
  return { d, dump: () => (on ? lines : undefined) };
}

function normalizeUrl(u) {
  if (!u) return null;
  u = String(u).trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u.replace(/^\/+/, "");
  try {
    const obj = new URL(u);
    if (!obj.host.toLowerCase().includes("amazon.")) return null;
    return obj.toString();
  } catch { return null; }
}

const pageWithParam = (url, n) => (n<=1 ? url : `${url}${url.includes("?") ? "&" : "?"}page=${n}`);
const money = (t) => { if(!t) return null; const m = String(t).match(/[₹]?\s*([\d,]+\.?\d*)/); return m ? Number(m[1].replace(/,/g,"")) : null; };
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
function parseBoughtPastMonth(s) {
  if (!s) return null;
  const lower = String(s).toLowerCase();
  if (!/bought in past month/.test(lower)) return null;
  // "10K+ bought in past month", "1,200+ bought", "500 bought"
  const mK = lower.match(/([\d,.]+)\s*k\+?/);
  if (mK) {
    const base = Number(mK[1].replace(/,/g,""));
    return isFinite(base) ? Math.round(base*1000) : null;
  }
  const mPlus = lower.match(/([\d,.]+)\s*\+/);
  if (mPlus) {
    const n = Number(mPlus[1].replace(/,/g,""));
    return isFinite(n) ? n : null;
  }
  const mPlain = lower.match(/([\d,.]+)\s*bought/);
  if (mPlain) {
    const n = Number(mPlain[1].replace(/,/g,""));
    return isFinite(n) ? n : null;
  }
  return null;
}

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

async function gotoWithRetries(page, url, sel, timeoutMs, dbg) {
  for (let attempt=0; attempt<2; attempt++) {
    try {
      dbg.d("goto attempt", { attempt:attempt+1, url });
      await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
      const title = await page.title().catch(()=> "");
      dbg.d("after goto", { title, cur: page.url() });
      await page.waitForSelector(sel, { timeout: timeoutMs });
      dbg.d("selector appeared", { readySel: sel });
      return { ok:true };
    } catch (e) {
      dbg.d("goto/wait error", { attempt, err:String(e) });
      if (attempt === 1) return { ok:false };
      await sleep(300);
    }
  }
  return { ok:false };
}

async function autoScroll(page, steps, pauseMs) {
  for (let i=0; i<steps; i++) {
    await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
    await sleep(pauseMs);
  }
}

/* ---------------- Amazon extractor ---------------- */
async function extractAmazonList(page, sourceUrl, listOffset, opts, limit, dbg, category) {
  const out = [];
  try { await page.waitForSelector("div.s-main-slot", { timeout: opts.timeoutMs }); }
  catch { dbg.d("amazon: s-main-slot not found"); return [out, listOffset]; }

  const cards = await page.$$("div.s-main-slot div.s-result-item[data-component-type='s-search-result']");
  dbg.d("amazon: cards", { n: cards.length, category });
  let pos = listOffset;

  for (const c of cards) {
    try {
      const titleEl = await c.$("h2 a span.a-size-medium") || await c.$("h2 a span") || await c.$("h2");
      let name = titleEl ? (await page.evaluate(el => el.textContent, titleEl))?.trim() : null;

      const linkEl = await c.$("h2 a");
      const href   = linkEl ? await page.evaluate(el => el.getAttribute("href"), linkEl) : null;
      const asin   = await page.evaluate(el => el.getAttribute("data-asin"), c);

      const product_url = href ? new URL(href, "https://www.amazon.in").toString()
                               : (asin ? `https://www.amazon.in/dp/${asin}` : null);

      const imgEl = await c.$("img.s-image");
      const image_url = imgEl ? await page.evaluate(el => el.getAttribute("src"), imgEl) : null;

      const priceEl = await c.$("span.a-price:not(.a-text-price) span.a-offscreen");
      const price   = money(priceEl ? await page.evaluate(el => el.textContent, priceEl) : null);

      const mrpEl   = await c.$("span.a-text-price span.a-offscreen");
      const mrp     = money(mrpEl ? await page.evaluate(el => el.textContent, mrpEl) : null);

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
        if (m) { const v = Number(m[1].replace(/,/g,'')); if (isFinite(v)) review_count = v; }
      }

      // "bought in past month"
      let items_sold_month = null;
      const deepText = await page.evaluate(node => node.innerText, c).catch(()=>null);
      items_sold_month = parseBoughtPastMonth(deepText);

      // badge (best seller / amazon's choice)
      let badge_best_seller = await page.evaluate(node => {
        const hit = Array.from(node.querySelectorAll(".a-badge-text, [aria-label]")).find(el=>{
          const t = (el.textContent||el.getAttribute?.("aria-label")||"").toLowerCase();
          return /best\s*seller|amazon'?s\s*choice/.test(t);
        });
        return !!hit;
      }, c).catch(()=>false);

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
          items_sold_month,
          badge_best_seller,
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

/* ---------------- Handler ---------------- */
module.exports.handler = async function (event) {
  const qs = event.queryStringParameters || {};
  const debugEnabled = String(qs.debug || "0") === "1";
  const shotEnabled  = String(qs.debug_shot || "0") === "1";
  const DBG = makeDebugger(debugEnabled);

  // Allow runtime overrides
  const timeoutMs    = Math.max(3000, parseInt(qs.timeout_ms || DEFAULT_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS);
  const hardLimitMs  = Math.max(timeoutMs*2, parseInt(qs.hard_limit_ms || DEFAULT_HARD_LIMIT_MS, 10) || DEFAULT_HARD_LIMIT_MS);
  const maxPages     = Math.max(1, Math.min(3, parseInt(qs.max_pages || DEFAULT_MAX_PAGES, 10) || DEFAULT_MAX_PAGES));
  const perListLimit = Math.max(6, Math.min(40, parseInt(qs.per_list_limit || DEFAULT_PER_LIST, 10) || DEFAULT_PER_LIST));

  const BASE_OPTS = {
    timeoutMs,
    minWaitMs: DEFAULT_MIN_WAIT,
    maxWaitMs: DEFAULT_MAX_WAIT,
    scrollSteps: DEFAULT_SCROLL_STEPS,
    scrollPauseMs: DEFAULT_SCROLL_PAUSE,
  };

  try {
    const customUrl = normalizeUrl(qs.amazon_url);
    const presetArg = (qs.preset || "all").toLowerCase(); // all | mobiles | mobile_accessories | laptops | laptop_accessories
    const usePreset = !customUrl;

    const work = [];
    if (usePreset) {
      const keys = presetArg === "all" ? PRESETS.map(p=>p.cat) : [presetArg];
      for (const cat of keys) {
        const found = PRESETS.find(p=>p.cat===cat);
        if (found) work.push(found);
      }
    } else {
      work.push({ url: customUrl, cat: "custom" });
    }

    DBG.d("params", { usePreset, presetArg, customUrl, maxPages, perListLimit, timeoutMs, hardLimitMs });

    // Global deadline + per-category budgets
    const globalDeadline = now() + hardLimitMs;
    const perCatBudgetMs = Math.max(3500, Math.floor(hardLimitMs / Math.max(1, work.length))); // at least ~3.5s per category
    DBG.d("budgets", { hardLimitMs, perCatBudgetMs, categories: work.length });

    // Launch headless
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
    await page.setUserAgent(UA_DESKTOPS[0]);
    await page.setExtraHTTPHeaders({
      "accept-language": "en-IN,en;q=0.9",
      "upgrade-insecure-requests": "1",
      "sec-fetch-mode": "navigate",
      referer: "https://www.google.com/",
    });

    const out = [];
    let shotBase64 = null;

    for (const job of work) {
      if (timeLeft(globalDeadline) < 800) { DBG.d("global deadline near; stop all"); break; }

      const catDeadline = now() + Math.min(perCatBudgetMs, timeLeft(globalDeadline));
      DBG.d("category start", { category: job.cat, url: job.url, catBudgetMs: timeLeft(catDeadline) });

      let pos = 0;
      for (let p=1; p<=maxPages; p++) {
        if (timeLeft(catDeadline) < 600) { DBG.d("category deadline near; stop pages", { category: job.cat }); break; }
        const url = pageWithParam(job.url, p);
        const nav = await gotoWithRetries(page, url, "div.s-main-slot", timeoutMs, DBG);
        if (!nav.ok) { DBG.d("nav failed", { category: job.cat, page: p }); break; }

        if (shotEnabled && !shotBase64) {
          shotBase64 = await page.screenshot({ type:"jpeg", quality:40, encoding:"base64" }).catch(()=>null);
        }
        await randWait(BASE_OPTS.minWaitMs, BASE_OPTS.maxWaitMs);
        await autoScroll(page, BASE_OPTS.scrollSteps, BASE_OPTS.scrollPauseMs);

        const [chunk, newPos] = await extractAmazonList(page, job.url, pos, BASE_OPTS, perListLimit, DBG, job.cat);
        pos = newPos;
        out.push(...chunk);

        // Heuristic: if we gathered enough for this category quickly, move on
        if (chunk.length < 3) { DBG.d("few items on page; early move on", { category: job.cat, page: p }); break; }
      }
      DBG.d("category done", { category: job.cat, collected: out.filter(r=>r.category===job.cat).length });
    }

    await browser.close();

    // de-dup by URL
    const seen = new Set(); const rows = [];
    for (const r of out) {
      const k = r.product_url || `${r.product_name}|${r.price}`;
      if (seen.has(k)) continue;
      seen.add(k); rows.push(r);
    }

    const payload = { ok:true, count: rows.length, rows };
    const dbg = DBG.dump();
    if (dbg) payload.debug = dbg;
    if (shotEnabled && shotBase64) payload.debug_screenshot = `data:image/jpeg;base64,${shotBase64}`;
    return resp(200, payload);
  } catch (err) {
    console.error("Function error:", err);
    return resp(500, { ok:false, error: String((err && err.message) || err) });
  }
};
