// netlify/functions/scrape.js
// Amazon listing scraper for Netlify Functions (Puppeteer + @sparticuz/chromium)
// - Focused on Amazon only
// - Supports built-in preset categories or a custom Amazon listing URL
// - Extracts: price, MRP, discount %, rating, review count, "bought in past month", best-seller badge
// - Adds a "category" field for UI tables

const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

/* ---------------- Config ---------------- */
const UA_DESKTOPS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
];

const BASE_OPTS = { timeoutMs: 8000, minWaitMs: 100, maxWaitMs: 250, scrollSteps: 2, scrollPauseMs: 150 };
const HARD_LIMIT_MS = 10000; // ~10s total budget

/* Preset categories (Amazon India) */
const PRESETS = [
  { cat: "mobiles", url: "https://www.amazon.in/s?k=trending+mobile+phones" },
  { cat: "mobile_accessories", url: "https://www.amazon.in/s?k=trending+mobile+phone+accessories" },
  { cat: "laptops", url: "https://www.amazon.in/s?k=trending+laptops" },
  { cat: "laptop_accessories", url: "https://www.amazon.in/s?k=trending+laptop+accessories" },
];

/* ---------------- Helpers ---------------- */
const resp = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(body),
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random()*(max-min+1))+min;
const randWait = (min, max) => sleep(rand(min, max));
const timeLeft = (deadline) => Math.max(0, deadline - Date.now());

function makeDebugger(enabled) {
  const lines = [];
  const d = (msg, extra) => { const L = `[${new Date().toISOString()}] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`;
    console.log(L); lines.push(L); };
  return { d, dump: () => (enabled ? lines : undefined) };
}

const normalizeUrl = (u) => { if (!u) return null; u = String(u).trim(); if (!/^https?:\/\//i.test(u)) u = "https://" + u.replace(/^\/+/, "");
  try { const obj = new URL(u); if (!obj.host.toLowerCase().includes("amazon.")) return null; return u; } catch { return null; } };

const pageWithParam = (url, n) => (n <= 1 ? url : `${url}${url.includes("?") ? "&" : "?"}page=${n}`);
const money = (t) => { if (!t) return null; const m = String(t).match(/[₹]?\s*([\d,]+\.?\d*)/); return m ? Number(m[1].replace(/,/g,"")) : null; };
const pctOff = (mrp, price) => (mrp && price && mrp > 0 && price <= mrp) ? Math.round((100*(mrp-price)/mrp)*10)/10 : null;
const brandGuess = (name) => {
  if (!name) return null;
  const map = { iphone:"Apple", mi:"Xiaomi", redmi:"Xiaomi", moto:"Motorola", poco:"Poco" };
  for (const raw of name.split(/\s+/).slice(0,5)){
    const t = raw.replace(/[^A-Za-z0-9+]/g,"").toLowerCase();
    if(map[t]) return map[t];
    const set = ["samsung","apple","xiaomi","oneplus","realme","vivo","oppo","iqoo","motorola","tecno","infinix","lava","nokia","honor","google","acer","poco","dell","hp","lenovo","asus","msi"];
    if(set.includes(t)) return t[0].toUpperCase()+t.slice(1);
  }
  return null;
};

// "10K+ bought in past month" -> 10000 (approx)
function parseBoughtPastMonth(s) {
  if (!s) return null;
  const m = String(s).toLowerCase().match(/([\d,.]+)\s*(k\+)?\s*bought/i);
  if (!m) return null;
  let num = Number(m[1].replace(/[,]/g,''));
  if (isNaN(num)) return null;
  if (m[2]) num = Math.round(num * 1000); // crude: "10K+" -> 10000
  return num;
}

async function gotoWithRetries(page, url, readySel, timeoutMs, dbg) {
  for (let attempt=0; attempt<2; attempt++){
    const t0 = Date.now();
    try {
      dbg.d("goto attempt", { attempt: attempt+1, url });
      await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
      const title = await page.title().catch(()=> "");
      const cur = page.url();
      dbg.d("after goto", { title, cur, dur_ms: Date.now()-t0 });

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

async function autoScroll(page, steps, pause) {
  for (let i=0;i<steps;i++) {
    await page.evaluate(()=> window.scrollBy(0, document.body.scrollHeight));
    await sleep(pause);
  }
}

/* --------------- Amazon extractor --------------- */
async function extractAmazonList(page, sourceUrl, listOffset, localOpts, limit, dbg, category) {
  const out = [];
  try { await page.waitForSelector("div.s-main-slot", { timeout: localOpts.timeoutMs }); }
  catch { dbg.d("amazon: s-main-slot not found"); return [out, listOffset]; }

  const cards = await page.$$("div.s-main-slot div.s-result-item[data-component-type='s-search-result']");
  dbg.d("amazon: cards", { n: cards.length });
  let pos = listOffset;

  for (const c of cards) {
    try {
      // Title & link
      const titleEl = await c.$("h2 a span.a-size-medium") || await c.$("h2 a span") || await c.$("h2");
      let name = titleEl ? (await page.evaluate(el => el.textContent, titleEl))?.trim() : null;
      const linkEl = await c.$("h2 a");
      const href = linkEl ? await page.evaluate(el => el.getAttribute("href"), linkEl) : null;

      const asin = await page.evaluate(el => el.getAttribute("data-asin"), c);
      const product_url = href ? new URL(href, "https://www.amazon.in").toString()
                               : (asin ? `https://www.amazon.in/dp/${asin}` : null);

      // Image
      const imgEl = await c.$("img.s-image");
      const image_url = imgEl ? await page.evaluate(el => el.getAttribute("src"), imgEl) : null;

      // Price / MRP
      const priceEl = await c.$("span.a-price:not(.a-text-price) span.a-offscreen");
      const price = money(priceEl ? await page.evaluate(el => el.textContent, priceEl) : null);

      const mrpEl = await c.$("span.a-text-price span.a-offscreen");
      const mrp = money(mrpEl ? await page.evaluate(el => el.textContent, mrpEl) : null);

      // Rating & reviews
      const ratingEl = await c.$("span.a-icon-alt");
      const ratingTxt = ratingEl ? await page.evaluate(el => el.textContent, ratingEl) : null; // "4.2 out of 5 stars"
      const rating = ratingTxt ? Number((ratingTxt.match(/([\d.]+)/)||[])[1]) : null;

      const reviewsEl = await c.$("span[aria-label$='ratings'], span[aria-label$='rating'], span.a-size-base.s-underline-text");
      const reviewsTxt = reviewsEl ? await page.evaluate(el => el.textContent, reviewsEl) : null;
      const review_count = reviewsTxt ? Number((reviewsTxt.replace(/[^\d,]/g,'').replace(/,/g,'')||'').trim()) || null : null;

      // "bought in past month"
      let boughtTxt = null;
      for (const sel of ["span:has(> span:contains('bought in past month'))", "span:contains('bought in past month')"]) {
        // Fallback: search by textContent
        if (!boughtTxt) {
          boughtTxt = await page.evaluate((node) => {
            const el = Array.from(node.querySelectorAll("span, div")).find(e => /bought in past month/i.test(e.textContent||""));
            return el ? el.textContent.trim() : null;
          }, c).catch(()=>null);
        }
      }
      const items_sold_month = parseBoughtPastMonth(boughtTxt);

      // Best seller badge
      const badge_best_seller = await page.evaluate((node) => {
        const el = Array.from(node.querySelectorAll("[aria-label], span")).find(e =>
          /best\s*sellers?/i.test(e.getAttribute?.("aria-label")||"") || /best\s*sellers?/i.test(e.textContent||"")
        );
        return !!el;
      }, c).catch(()=>false);

      if (name || price || product_url) {
        pos++;
        out.push({
          date: new Date().toISOString().slice(0,10),
          timestamp: new Date().toISOString(),
          platform: "amazon",
          category,                  // << added
          list_position: pos,
          product_name: name,
          brand_guess: brandGuess(name),
          price, mrp, discount_percent: pctOff(mrp, price),
          rating, review_count,
          items_sold_month,          // << added
          badge_best_seller,         // << added
          product_url, image_url, source_url: sourceUrl,
        });
        if (out.length >= limit) break;
      }
    } catch (e) { dbg.d("amazon: card parse error", { err: String(e) }); }
  }
  dbg.d("amazon: extracted", { n: out.length, category });
  return [out, pos];
}

/* --------------- Handler --------------- */
module.exports.handler = async function (event) {
  const params = event.queryStringParameters || {};
  const debugEnabled = String(params.debug || "0") === "1";
  const shotEnabled  = String(params.debug_shot || "0") === "1";
  const DBG = makeDebugger(debugEnabled);

  try {
    const customUrl = normalizeUrl(params.amazon_url);
    const usePreset = String(params.preset || (customUrl ? "0" : "1")) === "1";
    const maxPages = Math.max(1, Math.min(3, parseInt(params.max_pages || "1", 10) || 1)); // allow up to 3 if requested
    const perListLimit = 16; // slight bump to populate tables

    DBG.d("params", { customUrl, usePreset, raw: params });
    if (!usePreset && !customUrl)
      return resp(400, { ok:false, error:"Provide a valid Amazon listing URL or use preset=1", debug: DBG.dump() });

    // Time budget
    const deadline = Date.now() + HARD_LIMIT_MS;

    // Launch Chromium (Lambda)
    const executablePath = await chromium.executablePath();
    DBG.d("chromium path", { executablePath });
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1360, height: 900, deviceScaleFactor: 1 });
    await page.setUserAgent(UA_DESKTOPS[0]);
    await page.setExtraHTTPHeaders({
      "accept-language": "en-IN,en;q=0.9",
      "upgrade-insecure-requests": "1",
      "sec-fetch-mode": "navigate",
      "referer": "https://www.google.com/",
    });
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const t = req.resourceType();
      if (t === "image" || t === "media" || t === "font") return req.abort();
      req.continue();
    });

    const out = [];
    let shotBase64 = null;

    // Build worklist
    const work = [];
    if (usePreset) {
      work.push(...PRESETS.map(p => ({ url: p.url, cat: p.cat })));
    }
    if (customUrl) {
      work.push({ url: customUrl, cat: undefined });
    }

    for (const job of work) {
      if (timeLeft(deadline) < 1200) { DBG.d("deadline near, stop further pages"); break; }

      let pos = 0;
      for (let p=1; p<=maxPages; p++) {
        if (timeLeft(deadline) < 1200) { DBG.d("deadline near, stop amazon"); break; }
        const url = pageWithParam(job.url, p);
        const nav = await gotoWithRetries(page, url, "div.s-main-slot", BASE_OPTS.timeoutMs, DBG);
        if (!nav.ok) break;
        if (shotEnabled && !shotBase64) {
          shotBase64 = await page.screenshot({ type:"jpeg", quality:40, encoding:"base64" }).catch(()=>null);
        }
        await randWait(BASE_OPTS.minWaitMs, BASE_OPTS.maxWaitMs);
        await autoScroll(page, BASE_OPTS.scrollSteps, BASE_OPTS.scrollPauseMs);
        const [chunk, newPos] = await extractAmazonList(page, job.url, pos, BASE_OPTS, perListLimit, DBG, job.cat);
        pos = newPos; out.push(...chunk);
      }
    }

    await browser.close();

    // de-duplicate by URL
    const seen = new Set(), rows = [];
    for (const r of out) {
      const k = r.product_url || "";
      if (!k) continue;
      if (seen.has(k)) continue;
      seen.add(k); rows.push(r);
    }

    const result = { ok:true, count: rows.length, rows };
    const dbg = DBG.dump();
    if (dbg) result.debug = dbg;
    if (shotEnabled && shotBase64) result.debug_screenshot = `data:image/jpeg;base64,${shotBase64}`;
    return resp(200, result);
  } catch (err) {
    console.error("Function error:", err);
    return resp(500, { ok:false, error: String((err && err.message) || err) });
  }
};
