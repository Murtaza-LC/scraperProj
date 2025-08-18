// netlify/functions/scrape.js — CommonJS, puppeteer-core + @sparticuz/chromium

const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

/* ---------------- Config ---------------- */
const UA_LIST = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
];

const OPTS = {
  timeoutMs: 65000,
  minWaitMs: 900,
  maxWaitMs: 2200,
  scrollSteps: 8,
  scrollPauseMs: 650
};

/* ---------------- Utils ---------------- */
const resp = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(body)
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randWait = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1)) + min);

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
    ].includes(t)) {
      return t.charAt(0).toUpperCase() + t.slice(1);
    }
  }
  return null;
};

const pageWithParam = (url, n) => (n <= 1 ? url : `${url}${url.includes("?") ? "&" : "?"}page=${n}`);

async function autoScroll(page, steps = 8, pause = 650) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
    await sleep(pause);
  }
}

async function gotoWithRetries(page, url, readySel) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.setRequestInterception(true);
      page.removeAllListeners("request");
      page.on("request", (req) => {
        const t = req.resourceType();
        if (t === "image" || t === "media" || t === "font") return req.abort();
        req.continue();
      });
      await page.goto(url, { timeout: OPTS.timeoutMs, waitUntil: "domcontentloaded" });
      await page.waitForSelector(readySel, { timeout: OPTS.timeoutMs });
      return true;
    } catch {
      if (attempt === 2) return false;
      await sleep(1500 * (attempt + 1));
    }
  }
  return false;
}

const normalizeUrl = (u) => {
  if (!u) return null;
  u = u.trim();
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

/* ---------------- Amazon list ---------------- */
async function extractAmazonList(page, sourceUrl, listOffset = 0) {
  const out = [];
  try { await page.waitForSelector("div.s-main-slot", { timeout: OPTS.timeoutMs }); } catch { return [out, listOffset]; }
  const cards = await page.$$("div.s-main-slot div.s-result-item[data-component-type='s-search-result']");
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

      pos++;
      if (name || price || product_url) {
        out.push({
          date: new Date().toISOString().slice(0, 10),
          timestamp: new Date().toISOString(),
          platform: "amazon",
          list_position: pos,
          product_name: name,
          brand_guess: brandGuess(name),
          price, mrp, discount_percent: pctOff(mrp, price),
          rating: null, review_count: null,
          product_url, image_url, source_url: sourceUrl
        });
      }
    } catch {}
  }
  return [out, pos];
}

/* ---------------- Flipkart list ---------------- */
async function closeFlipkartPopups(page) {
  try { const btn = await page.$("button._2KpZ6l._2doB4z"); if (btn) await btn.click(); } catch {}
  try { await page.keyboard.press("Escape"); } catch {}
}
function flipkartRupees(text) {
  const vals = [...String(text || "").matchAll(/₹\s*([\d,]+\.?\d*)/g)].map(m => Number(m[1].replace(/,/g, "")));
  return [...new Set(vals)].sort((a, b) => b - a);
}
async function extractFlipkartList(page, sourceUrl, listOffset = 0) {
  const out = [];
  await closeFlipkartPopups(page);
  await sleep(800);
  await autoScroll(page, OPTS.scrollSteps, OPTS.scrollPauseMs);
  const anchors = await page.$$("a[href*='/p/']");
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

      seen.add(product_url); pos++;
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
          product_url, image_url: null, source_url: sourceUrl
        });
      }
    } catch {}
  }
  return [out, pos];
}

/* ---------------- Handler ---------------- */
module.exports.handler = async function (event) {
  try {
    const params = event.queryStringParameters || {};
    const amazonUrl   = ensureAllowed(normalizeUrl(params.amazon_url), "amazon");
    const flipkartUrl = ensureAllowed(normalizeUrl(params.flipkart_url), "flipkart");

    if (!amazonUrl && !flipkartUrl) {
      return resp(400, { ok: false, error: "Provide a valid Amazon and/or Flipkart listing URL (https://…)" });
    }

    const maxPages = Math.max(1, Math.min(3, parseInt(params.max_pages || "1", 10)));
    const pdpPrices = String(params.pdp_prices || "0").toLowerCase() === "1" ||
                      ["true", "yes"].includes(String(params.pdp_prices || "").toLowerCase());

    // Launch Chromium provided by @sparticuz/chromium
    const executablePath = await chromium.executablePath();
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless
    });

    // Use default browser context
    const page = await browser.newPage();
    await page.setUserAgent(UA_LIST[0]);
    await page.setViewport({ width: 1420, height: 980 });

    const out = [];

    // Amazon
    if (amazonUrl) {
      let pos = 0;
      for (let p = 1; p <= maxPages; p++) {
        const url = pageWithParam(amazonUrl, p);
        const ok = await gotoWithRetries(page, url, "div.s-main-slot");
        if (!ok) continue;
        await randWait(OPTS.minWaitMs, OPTS.maxWaitMs);
        await autoScroll(page, OPTS.scrollSteps, OPTS.scrollPauseMs);
        const [chunk, newPos] = await extractAmazonList(page, amazonUrl, pos);
        pos = newPos; out.push(...chunk);
      }
    }

    // Flipkart
    if (flipkartUrl) {
      let pos = 0;
      for (let p = 1; p <= maxPages; p++) {
        const url = pageWithParam(flipkartUrl, p);
        const ok = await gotoWithRetries(page, url, "a[href*='/p/']");
        if (!ok) continue;
        await randWait(OPTS.minWaitMs, OPTS.maxWaitMs);
        await autoScroll(page, OPTS.scrollSteps, OPTS.scrollPauseMs);
        const [chunk, newPos] = await extractFlipkartList(page, flipkartUrl, pos);
        pos = newPos; out.push(...chunk);
      }
    }

    // PDP enrichment intentionally disabled by default
    // if (pdpPrices && out.length) { ... }

    await browser.close();

    // de-duplicate by (platform, url)
    const seen = new Set(), rows = [];
    for (const r of out) {
      const k = `${r.platform}|${r.product_url}`;
      if (seen.has(k)) continue;
      seen.add(k); rows.push(r);
    }

    return resp(200, { ok: true, count: rows.length, rows });
  } catch (err) {
    console.error("Function error:", err);
    return resp(500, { ok: false, error: String((err && err.message) || err) });
  }
};
