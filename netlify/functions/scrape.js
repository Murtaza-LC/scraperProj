// netlify/functions/scrape.js
// Amazon + Flipkart listing scraper (serverless-safe)
// - Detects Flipkart reCAPTCHA and skips it to avoid 504s
// - Keeps work under ~9s total to avoid platform timeouts

const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

/* ---------------- Config ---------------- */
const UA_LIST = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
];

const BASE_OPTS = {
  timeoutMs: 16000,   // selector wait (non-fast)
  minWaitMs: 900,
  maxWaitMs: 2200,
  scrollSteps: 8,
  scrollPauseMs: 650,
};

// Keep total execution well below provider limits
const HARD_LIMIT_MS = 9000; // ~9s budget

/* ---------------- Utilities ---------------- */
const resp = (code, body) => ({
  statusCode: code,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  },
  body: JSON.stringify(body),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randWait = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1)) + min);
const timeLeft = (deadline) => Math.max(0, deadline - Date.now());

const money = (t) => {
  if (!t) return null;
  const m = String(t).match(/[₹]?\s*([\d,]+\.?\d*)/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
};
const pctOff = (mrp, price) =>
  mrp && price && mrp > 0 && price <= mrp ? Math.round((100 * (mrp - price) / mrp) * 10) / 10 : null;

const brandGuess = (name) => {
  if (!name) return null;
  const map = { iphone: "Apple", mi: "Xiaomi", redmi: "Xiaomi", moto: "Motorola" };
  for (const raw of name.split(/\s+/).slice(0, 4)) {
    const t = raw.replace(/[^A-Za-z0-9+]/g, "").toLowerCase();
    if (map[t]) return map[t];
    if ([
      "samsung","apple","xiaomi","oneplus","realme","vivo","oppo","iqoo",
      "motorola","tecno","infinix","lava","nokia","honor","google","acer","poco"
    ].includes(t)) return t.charAt(0).toUpperCase() + t.slice(1);
  }
  return null;
};

const pageWithParam = (url, n) => (n <= 1 ? url : `${url}${url.includes("?") ? "&" : "?"}page=${n}`);

function makeDebugger(enabled) {
  const lines = [];
  const d = (msg, extra) => {
    const line = `[${new Date().toISOString()}] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`;
    console.log(line);
    lines.push(line);
  };
  return { d, dump: () => (enabled ? lines : undefined) };
}

const normalizeUrl = (u) => {
  if (!u) return null;
  u = String(u).trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u.replace(/^\/+/, "");
  try { new URL(u); return u; } catch { return null; }
};

const ensureAllowed = (u, platform) => {
  if (!u) return null;
  const host = new URL(u).host.toLowerCase();
  if (platform === "amazon" && !host.includes("amazon.")) return null;
  if (platform === "flipkart" && !host.includes("flipkart.com")) return null;
  return u;
};

/* ---------------- Navigation helper ---------------- */
// Returns { ok:boolean, captcha:boolean }
async function gotoWithRetries(page, url, readySel, timeoutMs, dbg, { detectCaptchaTitle } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    try {
      dbg.d(`goto attempt ${attempt + 1}`, { url });
      await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });

      const title = await page.title().catch(() => "");
      const cur = page.url();
      dbg.d("after goto", { title, cur, dur_ms: Date.now() - t0 });

      // Early captcha detection
      if (detectCaptchaTitle && title && /recaptcha/i.test(title)) {
        dbg.d("captcha detected by title", { title });
        return { ok: false, captcha: true };
      }

      dbg.d("waiting for selector", { readySel });
      await page.waitForSelector(readySel, { timeout: timeoutMs });
      dbg.d("selector appeared", { readySel, dur_ms: Date.now() - t0 });

      const htmlLen = await page
        .evaluate(() => document.documentElement.outerHTML.length)
        .catch(() => -1);
      dbg.d("html length", { htmlLen });

      return { ok: true, captcha: false };
    } catch (e) {
      dbg.d("goto/wait error", { attempt, err: String(e) });
      if (attempt === 1) return { ok: false, captcha: false };
      await sleep(500);
    }
  }
  return { ok: false, captcha: false };
}

/* ---------------- Scrolling ---------------- */
async function autoScroll(page, steps, pause) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
    await sleep(pause);
  }
}

/* ---------------- Amazon extractor ---------------- */
async function extractAmazonList(page, sourceUrl, listOffset, localOpts, limit, dbg) {
  const out = [];
  try { await page.waitForSelector("div.s-main-slot", { timeout: localOpts.timeoutMs }); }
  catch { dbg.d("amazon: s-main-slot not found"); return [out, listOffset]; }

  const cards = await page.$$("div.s-main-slot div.s-result-item[data-component-type='s-search-result']");
  dbg.d("amazon: cards count", { n: cards.length });

  let pos = listOffset;
  for (const c of cards) {
    try {
      const titleEl = await c.$("h2 a span.a-size-medium") || await c.$("h2 a span") || await c.$("h2");
      let name = titleEl ? (await page.evaluate(el => el.textContent, titleEl))?.trim() : null;

      const linkEl = await c.$("h2 a");
      const href = linkEl ? await page.evaluate(el => el.getAttribute("href"), linkEl) : null;
      if (!name && linkEl) name = (await page.evaluate(el => el.getAttribute("aria-label"), linkEl)) || null;

      const asin = await page.evaluate(el => el.getAttribute("data-asin"), c);
      const product_url = href
        ? new URL(href, "https://www.amazon.in").toString()
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
          date: new Date().toISOString().slice(0, 10),
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
  dbg.d("amazon: extracted rows", { n: out.length });
  return [out, pos];
}

/* ---------------- Flipkart helpers + extractor ---------------- */
async function closeFlipkartPopups(page, dbg) {
  try {
    const btn = await page.$("button._2KpZ6l._2doB4z");
    if (btn) { await btn.click(); dbg.d("flipkart: closed popup button"); }
  } catch {}
  try { await page.keyboard.press("Escape"); } catch {}
}
function flipkartRupees(text) {
  const vals = [...String(text || "").matchAll(/₹\s*([\d,]+\.?\d*)/g)].map(m => Number(m[1].replace(/,/g, "")));
  return [...new Set(vals)].sort((a, b) => b - a);
}
async function extractFlipkartList(page, sourceUrl, listOffset, localOpts, limit, dbg) {
  const out = [];
  await closeFlipkartPopups(page, dbg);
  await sleep(200);
  await autoScroll(page, localOpts.scrollSteps, localOpts.scrollPauseMs);

  const anchors = await page.$$("a[href*='/p/']");
  dbg.d("flipkart: anchors count", { n: anchors.length });
  if (anchors.length === 0) {
    const title = await page.title().catch(() => "");
    dbg.d("flipkart: zero anchors, title", { title });
  }

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
        const filtered = nums.filter(n => n >= 3000);
        const ref = filtered.length ? filtered : nums;
        if (ref.length) {
          if (ref.length >= 2) { mrp = mrp ?? Math.max(ref[0], ref[1]); price = price ?? Math.min(ref[0], ref[1]); }
          else { price = price ?? ref[0]; }
        }
      }

      seen.add(product_url);
      pos++;
      if ((name || price) && product_url) {
        out.push({
          date: new Date().toISOString().slice(0, 10),
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
  dbg.d("flipkart: extracted rows", { n: out.length });
  return [out, pos];
}

/* ---------------- Handler ---------------- */
module.exports.handler = async function (event) {
  const params = event.queryStringParameters || {};
  const debugEnabled = String(params.debug || "0") === "1";
  const shotEnabled  = String(params.debug_shot || "0") === "1";
  const DBG = makeDebugger(debugEnabled);

  let captcha = { flipkart: false };

  try {
    const amazonUrl   = ensureAllowed(normalizeUrl(params.amazon_url), "amazon");
    const flipkartUrl = ensureAllowed(normalizeUrl(params.flipkart_url), "flipkart");

    DBG.d("params", { amazonUrl, flipkartUrl, raw: params });

    if (!amazonUrl && !flipkartUrl) {
      return resp(400, { ok: false, error: "Provide a valid Amazon and/or Flipkart listing URL (https://…)", debug: DBG.dump() });
    }

    // Budget
    const deadline = Date.now() + HARD_LIMIT_MS;

    // Fast mode always on by default here
    const fast = true;
    const localOpts = {
      timeoutMs: 8000,                 // tighter waits
      minWaitMs: 100,
      maxWaitMs: 250,
      scrollSteps: 2,
      scrollPauseMs: 150,
    };
    const maxPages = 1;                // keep lean
    const perSiteLimit = 12;

    // Puppeteer + Chromium (Lambda binary)
    const executablePath = await chromium.executablePath();
    DBG.d("chromium path", { executablePath });

    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setUserAgent(UA_LIST[0]);
    await page.setViewport({ width: 1360, height: 900 });
    await page.setExtraHTTPHeaders({
      "accept-language": "en-IN,en;q=0.9",
      "upgrade-insecure-requests": "1",
      "sec-fetch-mode": "navigate",
    });

    // Block heavy assets
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const t = req.resourceType();
      if (t === "image" || t === "media" || t === "font") return req.abort();
      req.continue();
    });

    const out = [];
    let shotBase64 = null;

    // Prefer Flipkart first (but abort quickly if captcha)
    const siteOrder = (amazonUrl && flipkartUrl) ? ["flipkart", "amazon"] : (flipkartUrl ? ["flipkart"] : ["amazon"]);

    for (const site of siteOrder) {
      if (timeLeft(deadline) < 1000) { DBG.d(`${site}: skipped due to deadline`); continue; }

      if (site === "flipkart") {
        if (!flipkartUrl) { DBG.d("flipkart: no url provided"); continue; }

        let pos = 0;
        for (let p = 1; p <= maxPages; p++) {
          if (timeLeft(deadline) < 1000) { DBG.d("deadline near, stop flipkart"); break; }
          const url = pageWithParam(flipkartUrl, p);

          // Early captcha detection via title
          const nav1 = await gotoWithRetries(page, url, "a[href*='/p/']", localOpts.timeoutMs, DBG, { detectCaptchaTitle: true });
          if (nav1.captcha) { captcha.flipkart = true; DBG.d("flipkart: captcha page, skipping site"); break; }
          let ok = nav1.ok;

          if (!ok) {
            // fallback to container grid selectors
            const nav2 = await gotoWithRetries(page, url, "div._1YokD2, div._2kHMtA, div.y0S0Pe", localOpts.timeoutMs, DBG, { detectCaptchaTitle: true });
            if (nav2.captcha) { captcha.flipkart = true; DBG.d("flipkart: captcha page (fallback), skipping site"); break; }
            ok = nav2.ok;
          }

          if (!ok) { DBG.d("flipkart: goto failed", { url }); break; }

          if (shotEnabled && !shotBase64) {
            shotBase64 = await page.screenshot({ type: "jpeg", quality: 40, encoding: "base64" }).catch(() => null);
          }
          await randWait(localOpts.minWaitMs, localOpts.maxWaitMs);
          await autoScroll(page, localOpts.scrollSteps, localOpts.scrollPauseMs);
          const [chunk, newPos] = await extractFlipkartList(page, flipkartUrl, pos, localOpts, perSiteLimit, DBG);
          pos = newPos; out.push(...chunk);
        }
      } else {
        if (!amazonUrl) { DBG.d("amazon: no url provided"); continue; }
        let pos = 0;
        for (let p = 1; p <= maxPages; p++) {
          if (timeLeft(deadline) < 1000) { DBG.d("deadline near, stop amazon"); break; }
          const url = pageWithParam(amazonUrl, p);
          const nav = await gotoWithRetries(page, url, "div.s-main-slot", localOpts.timeoutMs, DBG);
          if (!nav.ok) { DBG.d("amazon: goto failed", { url }); break; }

          if (shotEnabled && !shotBase64) {
            shotBase64 = await page.screenshot({ type: "jpeg", quality: 40, encoding: "base64" }).catch(() => null);
          }
          await randWait(localOpts.minWaitMs, localOpts.maxWaitMs);
          await autoScroll(page, localOpts.scrollSteps, localOpts.scrollPauseMs);
          const [chunk, newPos] = await extractAmazonList(page, amazonUrl, pos, localOpts, perSiteLimit, DBG);
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

    const result = { ok: true, count: rows.length, rows, captcha };
    if (debugEnabled) result.debug = DBG.dump();
    if (shotEnabled && shotBase64) result.debug_screenshot = `data:image/jpeg;base64,${shotBase64}`;

    return resp(200, result);
  } catch (err) {
    console.error("Function error:", err);
    return resp(500, { ok: false, error: String((err && err.message) || err) });
  }
};
