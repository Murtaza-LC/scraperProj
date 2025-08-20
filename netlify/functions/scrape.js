// netlify/functions/scrape.js
// Amazon + Flipkart listing scraper for Netlify Functions (Puppeteer + @sparticuz/chromium)
// - Flipkart anti-bot handling with mobile fallback (m.flipkart.com)
// - Tight time budget to avoid 504s
// - Debug lines + optional screenshot

const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

/* ---------------- Config ---------------- */
const UA_DESKTOPS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
];
const UA_MOBILE = "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36";

const BASE_OPTS = { timeoutMs: 8000, minWaitMs: 100, maxWaitMs: 250, scrollSteps: 2, scrollPauseMs: 150 };
const HARD_LIMIT_MS = 10000; // ~10s total budget

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
  try { new URL(u); return u; } catch { return null; } };
const ensureAllowed = (u, platform) => { if (!u) return null; const host = new URL(u).host.toLowerCase();
  if (platform === "amazon" && !host.includes("amazon.")) return null;
  if (platform === "flipkart" && !host.includes("flipkart.com")) return null;
  return u; };

const pageWithParam = (url, n) => (n <= 1 ? url : `${url}${url.includes("?") ? "&" : "?"}page=${n}`);
const money = (t) => { if (!t) return null; const m = String(t).match(/[₹]?\s*([\d,]+\.?\d*)/); return m ? Number(m[1].replace(/,/g,"")) : null; };
const pctOff = (mrp, price) => (mrp && price && mrp > 0 && price <= mrp) ? Math.round((100*(mrp-price)/mrp)*10)/10 : null;
const brandGuess = (name) => { if (!name) return null; const map = { iphone:"Apple", mi:"Xiaomi", redmi:"Xiaomi", moto:"Motorola" };
  for (const raw of name.split(/\s+/).slice(0,4)){ const t = raw.replace(/[^A-Za-z0-9+]/g,"").toLowerCase(); if(map[t]) return map[t];
    const set = ["samsung","apple","xiaomi","oneplus","realme","vivo","oppo","iqoo","motorola","tecno","infinix","lava","nokia","honor","google","acer","poco"];
    if(set.includes(t)) return t[0].toUpperCase()+t.slice(1); } return null; };

function flipToMobile(urlStr) {
  try {
    const u = new URL(urlStr);
    u.host = "m.flipkart.com";
    // remove some params that sometimes trigger bot checks
    u.searchParams.delete("otracker");
    return u.toString();
  } catch { return urlStr; }
}

/* --------------- Puppeteer hygiene --------------- */
async function hardenPage(page, { mobile = false } = {}) {
  // Minimal stealth-ish tweaks (no extra plugins to keep bundle small)
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "languages", { get: () => ["en-IN","en"] });
    Object.defineProperty(navigator, "platform", { get: () => "Win32" });
    window.chrome = { runtime: {} };
    const origQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (origQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(parameters);
    }
  });
  try { await page.emulateTimezone("Asia/Kolkata"); } catch {}
  if (mobile) {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  } else {
    await page.setViewport({ width: 1360, height: 900, deviceScaleFactor: 1 });
  }
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const t = req.resourceType();
    if (t === "image" || t === "media" || t === "font") return req.abort();
    req.continue();
  });
}

/* --------------- Navigation helper --------------- */
// Returns { ok, captcha }
async function gotoWithRetries(page, url, readySel, timeoutMs, dbg, { detectCaptchaTitle=false } = {}) {
  for (let attempt=0; attempt<2; attempt++){
    const t0 = Date.now();
    try {
      dbg.d("goto attempt", { attempt: attempt+1, url });
      await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
      const title = await page.title().catch(()=> "");
      const cur = page.url();
      dbg.d("after goto", { title, cur, dur_ms: Date.now()-t0 });

      if (detectCaptchaTitle && /recaptcha/i.test(title)) {
        dbg.d("captcha detected by title", { title });
        return { ok:false, captcha:true };
      }

      await page.waitForSelector(readySel, { timeout: timeoutMs });
      dbg.d("selector appeared", { readySel });
      return { ok:true, captcha:false };
    } catch (e) {
      dbg.d("goto/wait error", { attempt, err: String(e) });
      if (attempt === 1) return { ok:false, captcha:false };
      await sleep(400);
    }
  }
  return { ok:false, captcha:false };
}

async function autoScroll(page, steps, pause) {
  for (let i=0;i<steps;i++) {
    await page.evaluate(()=> window.scrollBy(0, document.body.scrollHeight));
    await sleep(pause);
  }
}

/* --------------- Amazon extractor --------------- */
async function extractAmazonList(page, sourceUrl, listOffset, localOpts, limit, dbg) {
  const out = [];
  try { await page.waitForSelector("div.s-main-slot", { timeout: localOpts.timeoutMs }); }
  catch { dbg.d("amazon: s-main-slot not found"); return [out, listOffset]; }

  const cards = await page.$$("div.s-main-slot div.s-result-item[data-component-type='s-search-result']");
  dbg.d("amazon: cards", { n: cards.length });
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

      if (name || price || product_url) {
        pos++;
        out.push({
          date: new Date().toISOString().slice(0,10),
          timestamp: new Date().toISOString(),
          platform: "amazon",
          list_position: pos,
          product_name: name,
          brand_guess: brandGuess(name),
          price, mrp, discount_percent: pctOff(mrp, price),
          rating: null, review_count: null,
          product_url, image_url, source_url: sourceUrl,
        });
        if (out.length >= limit) break;
      }
    } catch (e) { dbg.d("amazon: card parse error", { err: String(e) }); }
  }
  dbg.d("amazon: extracted", { n: out.length });
  return [out, pos];
}

/* --------------- Flipkart extractor --------------- */
async function closeFlipkartPopups(page, dbg) {
  try { const btn = await page.$("button._2KpZ6l._2doB4z, button:has-text('✕')"); if (btn) { await btn.click(); dbg.d("flipkart: closed dismiss"); } } catch {}
  try { await page.keyboard.press("Escape"); } catch {}
}
function flipkartRupees(t) {
  const vals = [...String(t||"").matchAll(/₹\s*([\d,]+\.?\d*)/g)].map(m => Number(m[1].replace(/,/g,"")));
  return [...new Set(vals)].sort((a,b)=> b-a);
}
async function extractFlipkartList(page, sourceUrl, listOffset, localOpts, limit, dbg) {
  const out = [];
  await closeFlipkartPopups(page, dbg);
  await sleep(200);
  await autoScroll(page, localOpts.scrollSteps, localOpts.scrollPauseMs);

  // Prefer narrow but stable anchor signature
  let anchors = await page.$$("a[href*='/p/']");
  if (anchors.length === 0) {
    // Fallback: container tiles
    const hasGrid = await page.$("div._1YokD2, div._2kHMtA, div.gUuXy-, div.y0S0Pe");
    if (!hasGrid) dbg.d("flipkart: no grid containers either");
  }
  dbg.d("flipkart: anchors", { n: anchors.length });

  const seen = new Set(); let pos = listOffset;
  for (const a of anchors) {
    try {
      const href = await page.evaluate(el => el.getAttribute("href"), a);
      if (!href) continue;
      const product_url = new URL(href, "https://www.flipkart.com").toString();
      if (seen.has(product_url)) continue;

      const containerHandle = await page.evaluateHandle(el =>
        el.closest("div._2kHMtA, div._4ddWXP, div._1AtVbE, div.gUuXy-, div.y0S0Pe") || el.parentElement, a
      );
      const container = containerHandle.asElement();

      let name = null;
      for (const sel of ["div._4rR01T","a.s1Q9rs","div.KzDlHZ","a.IRpwTa"]) {
        const node = await container.$(sel);
        if (node) { name = (await page.evaluate(el => el.textContent, node))?.trim(); if (name) break; }
      }
      if (!name) {
        const img = await container.$("img");
        if (img) name = await page.evaluate(el => el.getAttribute("alt"), img);
      }

      const priceEl = await container.$("div._30jeq3._1_WHN1") || await container.$("div._30jeq3");
      const mrpEl   = await container.$("div._3I9_wc._27UcVY")  || await container.$("div._3I9_wc");
      let price = money(priceEl ? await page.evaluate(el => el.textContent, priceEl) : null);
      let mrp   = money(mrpEl ? await page.evaluate(el => el.textContent, mrpEl) : null);

      if (price == null || mrp == null) {
        const ct = (await page.evaluate(el => el.textContent, container)) || "";
        const nums = flipkartRupees(ct);
        const pool = (nums.filter(n => n >= 3000).length ? nums.filter(n => n >= 3000) : nums);
        if (pool.length >= 2) { mrp = mrp ?? Math.max(pool[0], pool[1]); price = price ?? Math.min(pool[0], pool[1]); }
        else if (pool.length === 1) { price = price ?? pool[0]; }
      }

      seen.add(product_url);
      pos++;
      if ((name || price) && product_url) {
        out.push({
          date: new Date().toISOString().slice(0,10),
          timestamp: new Date().toISOString(),
          platform: "flipkart",
          list_position: pos,
          product_name: name,
          brand_guess: brandGuess(name),
          price, mrp, discount_percent: pctOff(mrp, price),
          rating: null, review_count: null,
          product_url, image_url: null, source_url: sourceUrl,
        });
        if (out.length >= limit) break;
      }
    } catch (e) { dbg.d("flipkart: anchor parse error", { err: String(e) }); }
  }
  dbg.d("flipkart: extracted", { n: out.length });
  return [out, pos];
}

/* --------------- Handler --------------- */
module.exports.handler = async function (event) {
  const params = event.queryStringParameters || {};
  const debugEnabled = String(params.debug || "0") === "1";
  const shotEnabled  = String(params.debug_shot || "0") === "1";
  const DBG = makeDebugger(debugEnabled);
  const captcha = { flipkart: false };

  try {
    const amazonUrl   = ensureAllowed(normalizeUrl(params.amazon_url), "amazon");
    const flipkartUrl = ensureAllowed(normalizeUrl(params.flipkart_url), "flipkart");
    const maxPages = 1;              // keep lean for serverless
    const perSiteLimit = 12;

    DBG.d("params", { amazonUrl, flipkartUrl, raw: params });
    if (!amazonUrl && !flipkartUrl)
      return resp(400, { ok:false, error:"Provide a valid Amazon and/or Flipkart listing URL (https://…)", debug: DBG.dump() });

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
    await hardenPage(page, { mobile:false });
    await page.setUserAgent(UA_DESKTOPS[0]);
    await page.setExtraHTTPHeaders({
      "accept-language": "en-IN,en;q=0.9",
      "upgrade-insecure-requests": "1",
      "sec-fetch-mode": "navigate",
      "referer": "https://www.google.com/",
    });

    const out = [];
    let shotBase64 = null;

    // Try Flipkart first so we can early-out if blocked; then Amazon.
    const siteOrder = (amazonUrl && flipkartUrl) ? ["flipkart","amazon"] : (flipkartUrl ? ["flipkart"] : ["amazon"]);

    for (const site of siteOrder) {
      if (timeLeft(deadline) < 1200) { DBG.d(`${site}: skipped due to deadline`); continue; }

      if (site === "flipkart") {
        if (!flipkartUrl) continue;

        // Attempt 1: desktop site, desktop UA
        let pos = 0;
        for (let p=1; p<=maxPages; p++) {
          if (timeLeft(deadline) < 1200) { DBG.d("deadline near, stop flipkart"); break; }
          const url = pageWithParam(flipkartUrl, p);
          const nav = await gotoWithRetries(page, url, "a[href*='/p/']", BASE_OPTS.timeoutMs, DBG, { detectCaptchaTitle: true });
          if (nav.captcha) { captcha.flipkart = true; break; }
          if (!nav.ok) {
            // Fallback to container selector
            const nav2 = await gotoWithRetries(page, url, "div._1YokD2, div._2kHMtA, div.gUuXy-, div.y0S0Pe", BASE_OPTS.timeoutMs, DBG, { detectCaptchaTitle: true });
            if (nav2.captcha) { captcha.flipkart = true; break; }
            if (!nav2.ok) break;
          }
          if (shotEnabled && !shotBase64) {
            shotBase64 = await page.screenshot({ type:"jpeg", quality:40, encoding:"base64" }).catch(()=>null);
          }
          await randWait(BASE_OPTS.minWaitMs, BASE_OPTS.maxWaitMs);
          await autoScroll(page, BASE_OPTS.scrollSteps, BASE_OPTS.scrollPauseMs);
          const [chunk, newPos] = await extractFlipkartList(page, flipkartUrl, pos, BASE_OPTS, perSiteLimit, DBG);
          pos = newPos; out.push(...chunk);
        }

        // If we got nothing and not already flagged captcha, try mobile fallback quickly
        if (!captcha.flipkart && !out.some(r => r.platform === "flipkart") && timeLeft(deadline) > 2000) {
          DBG.d("flipkart: trying mobile fallback");
          const mob = await browser.newPage();
          await mob.setUserAgent(UA_MOBILE);
          await hardenPage(mob, { mobile:true });
          await mob.setExtraHTTPHeaders({ "accept-language":"en-IN,en;q=0.9", "referer":"https://www.google.com/" });

          const murl = flipToMobile(flipkartUrl);
          const navM = await gotoWithRetries(mob, murl, "a[href*='/p/']", 6000, DBG, { detectCaptchaTitle: true });
          if (!navM.ok && !navM.captcha) {
            // try grid fallback once
            await gotoWithRetries(mob, murl, "div._1YokD2, div._2kHMtA, div.gUuXy-, div.y0S0Pe", 6000, DBG, { detectCaptchaTitle: true });
          }
          if (navM.captcha) captcha.flipkart = true;

          if (!captcha.flipkart) {
            await randWait(80,160);
            await autoScroll(mob, 2, 120);
            const [chunkM] = await extractFlipkartList(mob, murl, 0, { ...BASE_OPTS, timeoutMs: 6000 }, 10, DBG);
            out.push(...chunkM);
          }
          await mob.close();
        }
      }

      if (site === "amazon") {
        if (!amazonUrl) continue;
        let pos = 0;
        for (let p=1; p<=maxPages; p++) {
          if (timeLeft(deadline) < 1200) { DBG.d("deadline near, stop amazon"); break; }
          const url = pageWithParam(amazonUrl, p);
          const nav = await gotoWithRetries(page, url, "div.s-main-slot", BASE_OPTS.timeoutMs, DBG);
          if (!nav.ok) break;
          if (shotEnabled && !shotBase64) {
            shotBase64 = await page.screenshot({ type:"jpeg", quality:40, encoding:"base64" }).catch(()=>null);
          }
          await randWait(BASE_OPTS.minWaitMs, BASE_OPTS.maxWaitMs);
          await autoScroll(page, BASE_OPTS.scrollSteps, BASE_OPTS.scrollPauseMs);
          const [chunk, newPos] = await extractAmazonList(page, amazonUrl, pos, BASE_OPTS, 12, DBG);
          pos = newPos; out.push(...chunk);
        }
      }
    }

    await browser.close();

    // de-duplicate by (platform, url)
    const seen = new Set(), rows = [];
    for (const r of out) {
      const k = `${r.platform}|${r.product_url}`;
      if (seen.has(k)) continue;
      seen.add(k); rows.push(r);
    }

    const result = { ok:true, count: rows.length, rows, captcha };
    const dbg = DBG.dump();
    if (dbg) result.debug = dbg;
    if (shotEnabled && shotBase64) result.debug_screenshot = `data:image/jpeg;base64,${shotBase64}`;
    return resp(200, result);
  } catch (err) {
    console.error("Function error:", err);
    return resp(500, { ok:false, error: String((err && err.message) || err) });
  }
};
