# netlify/functions/scrape.py
# Serverless handler that returns JSON for Amazon+Flipkart in one go.

import json, re, random, asyncio, pathlib
from datetime import datetime
from urllib.parse import urljoin
from pydantic import BaseModel
from playwright.async_api import async_playwright
from typing import Optional, Tuple, List
from urllib.parse import urlparse

UA_LIST = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
]

def normalize_url(u: str | None) -> str | None:
    if not u: return None
    u = u.strip()
    if not u: return None
    if not u.lower().startswith(("http://", "https://")):
        u = "https://" + u.lstrip("/")
    pu = urlparse(u)
    if not pu.scheme or not pu.netloc:
        return None
    return u

def ensure_allowed(u: str | None, platform: str) -> str | None:
    if not u: return None
    host = urlparse(u).netloc.lower()
    if platform == "amazon" and "amazon." not in host:
        return None
    if platform == "flipkart" and "flipkart.com" not in host:
        return None
    return u
def _rand_wait(min_ms: int, max_ms: int) -> float:
    return random.randint(min_ms, max_ms) / 1000.0

def parse_money(text: Optional[str]) -> Optional[float]:
    if not text: return None
    m = re.findall(r"[₹]?\s*([\d,]+\.?\d*)", text)
    if not m: return None
    try: return float(m[0].replace(",", ""))
    except: return None

def pct_off(mrp: Optional[float], price: Optional[float]) -> Optional[float]:
    if mrp and price and mrp > 0 and price <= mrp:
        return round(100.0 * (mrp - price) / mrp, 1)
    return None

def brand_guess(name: Optional[str]) -> Optional[str]:
    if not name: return None
    tokens = name.split()
    for t in tokens[:4]:
        t = re.sub(r"[^A-Za-z0-9+]", "", t).lower()
        mapping = {"iphone":"Apple","mi":"Xiaomi","redmi":"Xiaomi","moto":"Motorola"}
        if t in mapping: return mapping[t]
        if t in {"samsung","apple","xiaomi","oneplus","realme","vivo","oppo","iqoo","motorola","tecno","infinix","lava","nokia","honor","google","acer","poco"}:
            return t.capitalize()
    return None

class ScrapeOptions(BaseModel):
    headless: bool = True
    min_wait_ms: int = 900
    max_wait_ms: int = 2200
    scroll_pause_ms: int = 650
    scroll_steps: int = 8
    timeout_ms: int = 65000
    pdp_concurrency: int = 4
    pdp_prices: bool = False

class SourceConfig(BaseModel):
    platform: str
    url: str
    max_pages: int = 1

async def auto_scroll(page, steps=8, pause_ms=650):
    for _ in range(steps):
        await page.evaluate("window.scrollBy(0, document.body.scrollHeight)")
        await asyncio.sleep(pause_ms/1000.0)

async def text_or_none(el):
    if not el: return None
    try:
        t = await el.text_content()
        return t.strip() if t else None
    except:
        return None

async def get_attr(el, name):
    if not el: return None
    try:
        v = await el.get_attribute(name)
        return v.strip() if isinstance(v, str) else v
    except:
        return None

def page_with_param(url: str, page_no: int) -> str:
    if page_no <= 1: return url
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}page={page_no}"

# ---------- Amazon list ----------
async def extract_amazon_list(page, source_url: str, list_offset=0, opts:ScrapeOptions|None=None):
    items = []
    try:
        await page.wait_for_selector('div.s-main-slot', timeout=opts.timeout_ms if opts else 45000)
    except:
        return [], list_offset

    cards = await page.query_selector_all('div.s-main-slot div.s-result-item[data-component-type="s-search-result"]')
    pos = list_offset
    for c in cards:
        try:
            title_el = await c.query_selector("h2 a span.a-size-medium") or await c.query_selector("h2 a span") or await c.query_selector("h2")
            name = await text_or_none(title_el)
            link_el  = await c.query_selector("h2 a")
            href = await get_attr(link_el, "href")
            if not name and link_el:
                name = await get_attr(link_el, "aria-label")
            asin = await get_attr(c, "data-asin")
            product_url = urljoin("https://www.amazon.in", href) if href else (f"https://www.amazon.in/dp/{asin}" if asin else None)
            img_el = await c.query_selector("img.s-image")
            image_url = await get_attr(img_el, "src") if img_el else None

            offscreen_curr = await c.query_selector("span.a-price:not(.a-text-price) span.a-offscreen")
            price = parse_money(await text_or_none(offscreen_curr))
            mrp_offscreen = await c.query_selector("span.a-text-price span.a-offscreen")
            mrp = parse_money(await text_or_none(mrp_offscreen))

            pos += 1
            if name or price or product_url:
                items.append(dict(
                    date=datetime.utcnow().date().isoformat(),
                    timestamp=datetime.utcnow().isoformat(),
                    platform="amazon",
                    list_position=pos,
                    product_name=name,
                    brand_guess=brand_guess(name),
                    price=price, mrp=mrp, discount_percent=pct_off(mrp, price),
                    rating=None, review_count=None,
                    product_url=product_url, image_url=image_url, source_url=source_url
                ))
        except Exception:
            continue
    return items, pos

# ---------- Flipkart list ----------
async def close_flipkart_popups(page):
    try:
        btn = await page.query_selector("button._2KpZ6l._2doB4z, button:has-text('✕')")
        if btn: await btn.click()
    except: pass
    try: await page.keyboard.press("Escape")
    except: pass

def flipkart_rupee_numbers(text: str) -> list[float]:
    vals = re.findall(r"₹\s*([\d,]+\.?\d*)", text or "")
    nums = []
    for v in vals:
        try:
            nums.append(float(v.replace(",", "")))
        except:
            pass
    return sorted(set(nums), reverse=True)

async def extract_flipkart_list(page, source_url: str, list_offset=0, opts:ScrapeOptions|None=None):
    items = []
    await close_flipkart_popups(page)
    await asyncio.sleep(0.8)
    await auto_scroll(page, steps=opts.scroll_steps if opts else 8, pause_ms=(opts.scroll_pause_ms if opts else 650))
    anchors = await page.query_selector_all("a[href*='/p/']")
    seen = set()
    pos = list_offset
    for a in anchors:
        try:
            href = await get_attr(a, "href")
            if not href: continue
            product_url = urljoin("https://www.flipkart.com", href)
            if product_url in seen: continue

            container = await a.evaluate_handle(
                """el => el.closest("div._2kHMtA, div._4ddWXP, div._1AtVbE, div.gUuXy-, div.y0S0Pe") || el.parentElement"""
            )

            title_el = await container.query_selector("div._4rR01T") or await container.query_selector("a.s1Q9rs") \
                       or await container.query_selector("div.KzDlHZ") or await container.query_selector("a.IRpwTa")
            name = await text_or_none(title_el)
            if not name:
                img = await container.query_selector("img")
                name = await get_attr(img, "alt") if img else None

            price_el = await container.query_selector("div._30jeq3._1_WHN1") or await container.query_selector("div._30jeq3")
            price = parse_money(await text_or_none(price_el))
            mrp_el = await container.query_selector("div._3I9_wc._27UcVY") or await container.query_selector("div._3I9_wc")
            mrp = parse_money(await text_or_none(mrp_el))

            if price is None or mrp is None:
                container_text = (await text_or_none(container)) or ""
                nums = flipkart_rupee_numbers(container_text)
                nums = [n for n in nums if n >= 3000] or nums
                if nums:
                    if len(nums) >= 2:
                        mrp = mrp or max(nums[:2]); price = price or min(nums[:2])
                    else:
                        price = price or nums[0]

            seen.add(product_url)
            pos += 1
            if (name or price) and product_url:
                items.append(dict(
                    date=datetime.utcnow().date().isoformat(),
                    timestamp=datetime.utcnow().isoformat(),
                    platform="flipkart",
                    list_position=pos,
                    product_name=name,
                    brand_guess=brand_guess(name),
                    price=price, mrp=mrp, discount_percent=pct_off(mrp, price),
                    rating=None, review_count=None,
                    product_url=product_url, image_url=None, source_url=source_url
                ))
        except Exception:
            continue
    return items, pos

# ---------- PDP (optional enrichment) ----------
async def extract_amazon_pdp(page) -> Tuple[Optional[float], Optional[float]]:
    price = None
    for sel in ["#corePrice_feature_div .a-offscreen", "#apex_desktop .a-offscreen", "span.a-price:not(.a-text-price) span.a-offscreen"]:
        el = await page.query_selector(sel)
        if el:
            price = parse_money(await text_or_none(el))
            if price: break
    mrp = None
    mrp_el = await page.query_selector("span.a-price.a-text-price span.a-offscreen")
    if mrp_el: mrp = parse_money(await text_or_none(mrp_el))
    return price, mrp

async def extract_flipkart_pdp(page) -> Tuple[Optional[float], Optional[float]]:
    price = None
    for sel in ["div._30jeq3._16Jk6d", "div.Nx9bqj.CxhGGd", "div._30jeq3"]:
        el = await page.query_selector(sel)
        if el:
            price = parse_money(await text_or_none(el))
            if price: break
    mrp = None
    mrp_el = await page.query_selector("div._3I9_wc._2p6lqe") or await page.query_selector("div._3I9_wc")
    if mrp_el: mrp = parse_money(await text_or_none(mrp_el))
    return price, mrp

async def enrich_with_pdp(browser, rows: List[dict], opts: ScrapeOptions):
    sem = asyncio.Semaphore(opts.pdp_concurrency)
    async def visit_and_fill(row: dict):
        async with sem:
            url = row.get("product_url")
            if not url: return
            context = await browser.new_context(
                user_agent=random.choice(UA_LIST),
                viewport={"width":1280,"height":900}, locale="en-IN"
            )
            page = await context.new_page()
            try:
                await page.goto(url, timeout=opts.timeout_ms, wait_until="domcontentloaded")
                await asyncio.sleep(_rand_wait(opts.min_wait_ms, opts.max_wait_ms))
                if "amazon" in url:
                    price, mrp = await extract_amazon_pdp(page)
                else:
                    price, mrp = await extract_flipkart_pdp(page)
                if price and not row.get("price"): row["price"] = price
                if mrp and not row.get("mrp"): row["mrp"] = mrp
                row["discount_percent"] = pct_off(row.get("mrp"), row.get("price"))
            except:
                pass
            finally:
                await context.close()
    await asyncio.gather(*[visit_and_fill(r) for r in rows if (opts.pdp_prices or r.get("price") is None)])

# ---------- Orchestrator ----------
async def goto_with_retries(page, url, timeout_ms, ready_selector):
    for attempt in range(3):
        try:
            await page.route("**/*", lambda route: route.abort() if route.request.resource_type in {"image","media","font"} else route.continue_())
            await page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
            await page.wait_for_selector(ready_selector, timeout=timeout_ms)
            return True
        except Exception as e:
            if attempt == 2:
                print(f"[WARN] Final attempt failed for {url}: {e}")
                return False
            await asyncio.sleep(1.5 * (attempt + 1))
    return False

async def scrape_source(browser, source: SourceConfig, options: ScrapeOptions):
    context = await browser.new_context(
        user_agent=random.choice(UA_LIST),
        viewport={"width":1420,"height":980}, locale="en-IN"
    )
    page = await context.new_page()
    out, list_pos = [], 0
    for page_no in range(1, source.max_pages + 1):
        url = page_with_param(source.url, page_no)
        print(f"[{source.platform}] Listing page {page_no}: {url}")
        ok = await goto_with_retries(page, url, options.timeout_ms,
                                     "div.s-main-slot" if source.platform.startswith("amazon") else "a[href*='/p/']")
        if not ok: continue
        await asyncio.sleep(_rand_wait(options.min_wait_ms, options.max_wait_ms))
        await auto_scroll(page, steps=options.scroll_steps, pause_ms=options.scroll_pause_ms)
        if source.platform.startswith("amazon"):
            chunk, list_pos = await extract_amazon_list(page, source.url, list_offset=list_pos, opts=options)
        else:
            chunk, list_pos = await extract_flipkart_list(page, source.url, list_offset=list_pos, opts=options)
        out.extend(chunk)
    await context.close()
    return out

async def run_scrape(amazon_url: Optional[str], flipkart_url: Optional[str],
                     max_pages: int = 1, pdp_prices: bool = False) -> list[dict]:
    sources = []
    if amazon_url:  sources.append(SourceConfig(platform="amazon",   url=amazon_url,   max_pages=max_pages))
    if flipkart_url:sources.append(SourceConfig(platform="flipkart", url=flipkart_url, max_pages=max_pages))
    if not sources: return []

    opts = ScrapeOptions(pdp_prices=pdp_prices, headless=True)
    out_rows: List[dict] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            results = await asyncio.gather(*[scrape_source(browser, s, opts) for s in sources])
            for res in results: out_rows.extend(res)
            await enrich_with_pdp(browser, out_rows, opts)
        finally:
            await browser.close()
    # de-dup per platform
    seen = set()
    deduped = []
    for r in out_rows:
        key = (r.get("platform"), r.get("product_url"))
        if key in seen: continue
        seen.add(key)
        deduped.append(r)
    return deduped

# -------- Netlify handler --------
def handler(event, context):
     try:
        params = event.get("queryStringParameters") or {}
        amazon_url   = ensure_allowed(normalize_url(params.get("amazon_url")), "amazon")
        flipkart_url = ensure_allowed(normalize_url(params.get("flipkart_url")), "flipkart")

        if not amazon_url and not flipkart_url:
            return {
                "statusCode": 400,
                "headers": {"Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*"},
                "body": json.dumps({"ok": False, "error": "Please provide a valid Amazon and/or Flipkart listing URL starting with https://"})
            }

        max_pages  = int(params.get("max_pages") or 1)
        pdp_prices = params.get("pdp_prices", "0").lower() in {"1","true","yes"}

        data = asyncio.run(run_scrape(amazon_url, flipkart_url, max_pages, pdp_prices))
        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*"},
            "body": json.dumps({"ok": True, "count": len(data), "rows": data})
        }
    except Exception as e:
        # Log the inputs for debugging (shows up in Netlify function logs)
        print("handler error:", repr(e), "params=", event.get("queryStringParameters"))
        return {
            "statusCode": 500,
            "headers": {"Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*"},
            "body": json.dumps({"ok": False, "error": str(e)})
        }
