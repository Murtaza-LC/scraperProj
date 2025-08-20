/* ---------- Tiny DOM helpers ---------- */
const $ = (s, r=document)=>r.querySelector(s);
const $$ = (s, r=document)=>Array.from(r.querySelectorAll(s));

/* ---------- State ---------- */
let rows = [];             // all rows from backend
let activeCat = 'mobiles'; // which tab is selected
let viewRows = [];         // rows visible in the first pane (current tab only)

/* ---------- URL normalization ---------- */
function normalizeInputUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try {
    const u = new URL(s);
    if (!u.host.toLowerCase().includes('amazon.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/* ---------- Helpers ---------- */
function priceView(p){ return p!=null ? `₹${Number(p).toLocaleString('en-IN')}` : "—"; }
function discountView(d){ return d!=null ? `${d}%` : '—'; }
function boughtView(n){ return n!=null ? n.toLocaleString('en-IN') : '—'; }

function brandFromName(name) {
  if (!name) return null;
  const m = (name.match(/^\s*([A-Za-z+]+)/) || [])[1];
  return m || null;
}
function modelFromName(name, brand_guess) {
  if (!name) return '';
  if (brand_guess) {
    const re = new RegExp('^\\s*' + brand_guess.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i');
    return name.replace(re, '').trim();
  }
  const b = brandFromName(name);
  if (b) return name.replace(new RegExp('^\\s*' + b + '\\s*', 'i'), '').trim();
  return name;
}

/* ---------- Rendering: First pane (active tab) ---------- */
function card(r){
  const ratingsTag = (r.rating!=null || r.review_count!=null)
    ? `<span class="tag">${r.rating!=null?r.rating.toFixed(1):'–'} ★ • ${r.review_count!=null?r.review_count.toLocaleString('en-IN'):'–'}</span>` : '';
  const boughtTag = (r.items_sold_month!=null || r.bought_past_month!=null)
    ? `<span class="tag">${(r.items_sold_month ?? r.bought_past_month).toLocaleString('en-IN')} bought/mo</span>` : '';
  const badge = (r.badge_best_seller || r.badge) ? `<span class="tag">${r.badge ? r.badge : 'Best seller'}</span>` : '';
  return `
    <a class="item" href="${r.product_url}" target="_blank" rel="noopener">
      ${r.image_url ? `<img src="${r.image_url}" alt="">` : `<img alt="">`}
      <div>
        <div class="name">${r.product_name || '(No title)'}</div>
        <div class="muted">${r.brand_guess || ''}</div>
        <div class="row" style="gap:6px; margin-top:6px">${badge}${ratingsTag}${boughtTag}</div>
      </div>
      <div style="text-align:right">
        <div class="price">${priceView(r.price)}</div>
        <div class="muted" style="text-decoration:line-through">${r.mrp?priceView(r.mrp):''}</div>
        <div class="muted">${r.discount_percent!=null ? `${r.discount_percent}% off` : ''}</div>
      </div>
    </a>
  `;
}

function renderActiveList() {
  const src = rows.filter(r => r.category === activeCat || (activeCat==='custom' && r.category==null));
  const term = ($('#search').value||'').toLowerCase();
  viewRows = src.filter(r => !term || (r.product_name||'').toLowerCase().includes(term));
  $('#countActive').textContent = `${viewRows.length} items`;
  $('#listActive').innerHTML = viewRows.map(card).join('');
}

/* ---------- Sorting for first pane ---------- */
function sortActive(mode){
  const key = {
    discount: (r)=> (r.discount_percent==null ? -Infinity : r.discount_percent),
    lowest:   (r)=> (r.price==null ? Infinity : r.price) * -1, // reverse later
    highest:  (r)=> (r.price==null ? -Infinity : r.price),
    reviews:  (r)=> (r.review_count==null ? -Infinity : r.review_count),
  }[mode];

  const arr = viewRows.slice().sort((a,b)=> key(b)-key(a));
  if (mode==='lowest') arr.reverse();
  viewRows = arr;
  $('#listActive').innerHTML = viewRows.map(card).join('');
}

/* ---------- Rendering: Second pane tables ---------- */
function buildTable(rowsForCat, tableId, countId) {
  const tbl = $(tableId);
  const countEl = $(countId);
  if (!tbl) return;

  // sort by items_sold_month / bought_past_month desc, fallback to review_count desc
  const sorted = rowsForCat.slice().sort((a,b)=>{
    const A = (a.items_sold_month ?? a.bought_past_month ?? -1);
    const B = (b.items_sold_month ?? b.bought_past_month ?? -1);
    if (B!==A) return B - A;
    const Ar = (a.review_count!=null ? a.review_count : -1);
    const Br = (b.review_count!=null ? b.review_count : -1);
    return Br - Ar;
  }).slice(0, 10); // top 10

  tbl.innerHTML = `
    <thead>
      <tr>
        <th>#</th>
        <th>Brand</th>
        <th>Model</th>
        <th>Price</th>
        <th>Discount</th>
        <th>Bought (month)</th>
      </tr>
    </thead>
    <tbody>
      ${sorted.map((r, i)=>`
        <tr>
          <td>${i+1}</td>
          <td>${r.brand_guess || brandFromName(r.product_name) || '—'}</td>
          <td><a href="${r.product_url}" target="_blank" rel="noopener">${modelFromName(r.product_name, r.brand_guess)}</a></td>
          <td>${priceView(r.price)}</td>
          <td>${discountView(r.discount_percent)}</td>
          <td>${boughtView(r.items_sold_month ?? r.bought_past_month)}</td>
        </tr>
      `).join('')}
    </tbody>
  `;
  if (countEl) countEl.textContent = `${rowsForCat.length} items`;
}

function renderTables(){
  const byCat = {
    mobiles: rows.filter(r=>r.category==='mobiles'),
    mobile_accessories: rows.filter(r=>r.category==='mobile_accessories'),
    laptops: rows.filter(r=>r.category==='laptops'),
    laptop_accessories: rows.filter(r=>r.category==='laptop_accessories'),
  };
  buildTable(byCat.mobiles, '#tbl_mobiles', '#count_mobiles');
  buildTable(byCat.mobile_accessories, '#tbl_mobile_accessories', '#count_mobile_accessories');
  buildTable(byCat.laptops, '#tbl_laptops', '#count_laptops');
  buildTable(byCat.laptop_accessories, '#tbl_laptop_accessories', '#count_laptop_accessories');
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

/* ---------- Fetch ---------- */
function getNumberOrNull(el, min, max) {
  const v = (el?.value || '').trim();
  if (!v) return null;
  const n = Number(v);
  if (!isFinite(n)) return null;
  if (min!=null && n < min) return min;
  if (max!=null && n > max) return max;
  return Math.floor(n);
}

async function run() {
  const custom = normalizeInputUrl($('#amazonUrl')?.value);

  // Advanced fields
  const timeoutMs   = getNumberOrNull($('#advTimeoutMs'), 3000, 60000);
  const hardLimitMs = getNumberOrNull($('#advHardLimitMs'), 8000, 90000);
  const perList     = getNumberOrNull($('#advPerListLimit'), 6, 40);
  const preset      = ($('#advPreset')?.value || 'all');

  const btn = $('#run');
  btn.disabled = true; btn.textContent = 'Fetching…';
  showDebug(); // hide previous
  try {
    const fnUrl = new URL('/.netlify/functions/scrape', window.location.origin);

    // pages (existing control)
    const pages = String(Math.max(1, Math.min(3, parseInt(($('#maxPages')?.value || '1'), 10) || 1)));
    fnUrl.searchParams.set('max_pages', pages);

    // debug flags
    if ($('#dbg')?.checked) fnUrl.searchParams.set('debug', '1');
    if ($('#dbgshot')?.checked) fnUrl.searchParams.set('debug_shot', '1');

    // advanced values (only send if provided)
    if (timeoutMs!=null)   fnUrl.searchParams.set('timeout_ms', String(timeoutMs));
    if (hardLimitMs!=null) fnUrl.searchParams.set('hard_limit_ms', String(hardLimitMs));
    if (perList!=null)     fnUrl.searchParams.set('per_list_limit', String(perList));

    // routing: custom URL or presets
    if (custom) {
      fnUrl.searchParams.set('amazon_url', custom);
    } else {
      fnUrl.searchParams.set('preset', preset || 'all'); // all or single category
    }

    const res = await fetch(fnUrl.toString(), { method: 'GET' });
    const data = await res.json().catch(()=> ({}));

    if (data && (data.debug || data.debug_screenshot)) showDebug(data.debug, data.debug_screenshot);
    if (!res.ok || data.ok === false) {
      const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
      throw new Error(msg);
    }

    rows = Array.isArray(data.rows) ? data.rows : [];
    // If custom URL was used, mark it as a temporary "custom" category for the active list
    if (custom) {
      rows.forEach(r => { if (r.category == null) r.category = 'custom'; });
      activeCat = 'custom';
      // Deactivate tabs visually if custom run
      $$('.tab').forEach(x => x.classList.remove('active'));
    } else {
      // if a specific preset (not 'all') was chosen, select its tab
      if (preset && preset !== 'all') {
        activeCat = preset;
        $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.cat === preset));
      } else {
        activeCat = 'mobiles';
        $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.cat === 'mobiles'));
      }
    }

    // Render
    renderActiveList();
    renderTables();
  } catch (err) {
    console.error('Fetch failed:', err);
    alert('Fetch failed: ' + (err?.message || err));
  } finally {
    btn.disabled = false; btn.textContent = 'Fetch';
  }
}

/* ---------- Events ---------- */
document.addEventListener('DOMContentLoaded', () => {
  $('#run').addEventListener('click', run);
  $('#search').addEventListener('input', renderActiveList);

  // tabs
  $$('.tab').forEach(t => {
    t.addEventListener('click', () => {
      if (t.dataset.cat === 'custom') return;
      $$('.tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      activeCat = t.dataset.cat;
      renderActiveList();
    });
  });

  // sort pills
  $$('.pill').forEach(p => p.addEventListener('click', ()=> sortActive(p.dataset.sort)));
});
