/* ---------- Tiny DOM helpers ---------- */
const $ = (s, r=document)=>r.querySelector(s);
const $$ = (s, r=document)=>Array.from(r.querySelectorAll(s));

/* ---------- App state ---------- */
let rows = [];      // unified rows from backend
let filtered = [];  // after search/sort

/* ---------- Constants ---------- */
const CATEGORY_LABELS = {
  mobiles: "Trending Mobile Phones",
  mobile_accessories: "Trending Mobile Phone Accessories",
  laptops: "Trending Laptops",
  laptop_accessories: "Trending Laptop Accessories",
};

/* ---------- URL normalization ---------- */
function normalizeInputUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try {
    const u = new URL(s);
    const host = u.host.toLowerCase();
    if (!host.includes('amazon.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/* ---------- Rendering ---------- */
function priceView(p){ return p!=null ? `₹${Number(p).toLocaleString('en-IN')}` : "—"; }
function pctView(p){ return p!=null ? `${p}%` : "—"; }
function soldView(n){ return n!=null ? n.toLocaleString('en-IN') : "—"; }

function viewItem(r){
  const img = r.image_url ? `<img src="${r.image_url}" alt="">` : `<img alt="">`;
  const disc = r.discount_percent!=null ? `<span class="tag">${r.discount_percent}% off</span>` : ``;
  const rev  = r.review_count!=null ? `<span class="tag">${r.review_count} reviews</span>` : ``;
  const bought = (r.items_sold_month!=null) ? `<span class="tag ok">${r.items_sold_month.toLocaleString('en-IN')} bought/mo</span>` : ``;
  const badge = r.badge_best_seller ? `<span class="badge">Best seller</span>` : ``;
  const cat = r.category ? `<span class="muted">${CATEGORY_LABELS[r.category]||r.category}</span>` : ``;

  return `
  <a class="item" href="${r.product_url}" target="_blank" rel="noopener">
    ${img}
    <div>
      <div class="name">${r.product_name || '(No title)'} ${badge}</div>
      <div class="muted">${r.brand_guess || ''}</div>
      <div class="muted">${r.platform} • ${cat}</div>
      <div class="row" style="gap:8px; margin-top:6px">${disc}${rev}${bought}</div>
    </div>
    <div style="text-align:right">
      <div class="price">${priceView(r.price)}</div>
      <div class="muted" style="text-decoration:line-through">${r.mrp?priceView(r.mrp):''}</div>
    </div>
  </a>`;
}

function renderAmazonList(){
  $('#countAmazon').textContent = `${filtered.length} items`;
  $('#listAmazon').innerHTML = filtered.map(viewItem).join("");
}

/* ---------- Tables (second pane) ---------- */
function renderTables() {
  const groups = {
    mobiles: [],
    mobile_accessories: [],
    laptops: [],
    laptop_accessories: [],
  };
  for (const r of rows) {
    if (groups[r.category]) groups[r.category].push(r);
  }
  const sortFn = (a,b) => {
    const aSold = a.items_sold_month ?? -1;
    const bSold = b.items_sold_month ?? -1;
    if (aSold !== bSold) return bSold - aSold; // by items sold desc
    const aRev = a.review_count ?? -1;
    const bRev = b.review_count ?? -1;
    if (aRev !== bRev) return bRev - aRev;     // tie-break by reviews
    const aDisc = a.discount_percent ?? -1;
    const bDisc = b.discount_percent ?? -1;
    return bDisc - aDisc;                       // then by discount
  };

  Object.entries(groups).forEach(([cat, arr]) => {
    const tbody = $(`#tbl_${cat} tbody`);
    if (!tbody) return;
    const top = arr.slice().sort(sortFn).slice(0, 20);
    tbody.innerHTML = top.map((r, i) => `
      <tr>
        <td>${i+1}</td>
        <td>${r.brand_guess || '—'}</td>
        <td><a href="${r.product_url}" target="_blank" rel="noopener">${r.product_name || '—'}</a></td>
        <td>${priceView(r.price)}</td>
        <td>${pctView(r.discount_percent)}</td>
        <td>${soldView(r.items_sold_month)}</td>
      </tr>
    `).join("");
  });
}

/* ---------- Search + Sort + Filter ---------- */
function currentFilterCat() {
  const v = $('#categoryFilter')?.value || '';
  return v;
}
function applySearchAndSort(){
  const term = ($('#search').value||'').toLowerCase();
  const cat = currentFilterCat();
  filtered = rows.filter(r => (!cat || r.category===cat) && (!term || (r.product_name||'').toLowerCase().includes(term)));
  renderAmazonList();
}
function sortBy(mode){
  const key = {
    discount: (r)=> (r.discount_percent==null ? -Infinity : r.discount_percent),
    lowest:   (r)=> (r.price==null ? Infinity : r.price) * -1, // reverse later
    highest:  (r)=> (r.price==null ? -Infinity : r.price),
    reviews:  (r)=> (r.review_count==null ? -Infinity : r.review_count),
  }[mode];

  const arr = filtered.slice();
  arr.sort((a,b)=> (key(b)-key(a))); // desc
  if(mode==='lowest'){ arr.reverse(); } // asc
  filtered = arr;
  renderAmazonList();
}

/* ---------- Debug panel ---------- */
function showDebug(lines, shot) {
  const box = $('#debugOut');
  if (!lines && !shot) { box.style.display='none'; box.textContent=''; return; }
  let text = '';
  if (Array.isArray(lines)) text += lines.join('\n');
  box.textContent = text || '(no debug lines)';
  box.style.display = 'block';
  if (shot) {
    const img = new Image();
    img.src = shot;
    img.alt = 'debug screenshot';
    img.style.display = 'block';
    img.style.maxWidth = '100%';
    img.style.marginTop = '8px';
    box.appendChild(img);
  }
}

/* ---------- Scrape trigger ---------- */
async function run() {
  const amazon = normalizeInputUrl($('#amazonUrl')?.value);

  const btn = $('#run');
  btn.disabled = true; btn.textContent = 'Scraping...';
  showDebug(); // hide previous

  try {
    const fnUrl = new URL('/.netlify/functions/scrape', window.location.origin);

    // If a custom URL is provided, use it; else fetch all four presets
    if (amazon) {
      fnUrl.searchParams.set('amazon_url', amazon);
    } else {
      fnUrl.searchParams.set('preset', '1');
    }

    fnUrl.searchParams.set('fast', '1');
    fnUrl.searchParams.set('max_pages', String(Math.max(1, Math.min(3, parseInt(($('#maxPages')?.value || '1'), 10) || 1))));
    if ($('#dbg')?.checked) fnUrl.searchParams.set('debug', '1');
    if ($('#dbgshot')?.checked) fnUrl.searchParams.set('debug_shot', '1');

    const res = await fetch(fnUrl.toString(), { method: 'GET' });
    const data = await res.json().catch(() => ({}));

    if (data && (data.debug || data.debug_screenshot)) {
      showDebug(data.debug, data.debug_screenshot);
    }

    if (!res.ok || data.ok === false) {
      const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
      throw new Error(msg);
    }

    rows = (data.rows || []).filter(r => r.platform === 'amazon');
    filtered = rows.slice();

    // Default filter chip: none (Show All)
    $$('.chip').forEach(c => c.classList.remove('active'));
    $(`.chip[data-cat=""]`)?.classList.add('active');
    $('#categoryFilter').value = '';

    applySearchAndSort();
    renderTables();
  } catch (err) {
    console.error('Scrape failed:', err);
    alert('Scrape failed: ' + (err?.message || err));
  } finally {
    btn.disabled = false; btn.textContent = 'Scrape';
  }
}

/* ---------- Event wiring ---------- */
document.addEventListener('DOMContentLoaded', () => {
  $('#run').addEventListener('click', run);
  $('#search').addEventListener('input', applySearchAndSort);
  $$('.pill').forEach(p => p.addEventListener('click', ()=> sortBy(p.dataset.sort)));
  $('#categoryFilter').addEventListener('change', applySearchAndSort);

  // Quick category chips -> just set the dropdown + filter
  $$('#categoryChips .chip').forEach(ch => {
    ch.addEventListener('click', () => {
      $$('#categoryChips .chip').forEach(c => c.classList.remove('active'));
      ch.classList.add('active');
      const cat = ch.dataset.cat || '';
      $('#categoryFilter').value = cat;
      applySearchAndSort();
    });
  });
});
