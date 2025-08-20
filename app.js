/* ---------- Tiny DOM helpers ---------- */
const $ = (s, r=document)=>r.querySelector(s);
const $$ = (s, r=document)=>Array.from(r.querySelectorAll(s));

/* ---------- State ---------- */
let rows = [];              // merged results from category calls
let activeCat = 'mobiles';  // current tab
let filtered = [];          // current-tab filtered list

/* ---------- Helpers ---------- */
function priceView(p){ return p!=null ? `₹${Number(p).toLocaleString('en-IN')}` : "—"; }
function pctView(p){ return p!=null ? `${p}%` : "—"; }
function boughtView(n){ return n!=null ? n.toLocaleString('en-IN') : "—"; }
function labelFor(cat){ return ({mobiles:'Mobiles',mobile_accessories:'Mobile Accessories',laptops:'Laptops',laptop_accessories:'Laptop Accessories',custom:'Custom'})[cat] || cat; }
function modelFromName(name){
  if(!name) return '—';
  const parts = name.split(/\s+/);
  if (parts.length<=1) return name;
  return parts.slice(1,10).join(' ');
}

/* ---------- FIRST PANE: horizontal row view ---------- */
function hRow(r){
  const tags = [];
  if (r.discount_percent!=null) tags.push(`<span class="tag">${r.discount_percent}% off</span>`);
  if (r.bought_past_month!=null) tags.push(`<span class="tag">${r.bought_past_month.toLocaleString('en-IN')} bought/mo</span>`);
  if (r.rating!=null) tags.push(`<span class="tag">${r.rating.toFixed(1)} ★</span>`);
  const mrp = r.mrp ? `<div class="strike">${priceView(r.mrp)}</div>` : '';
  const img = r.image_url ? `<img src="${r.image_url}" alt="">` : `<img alt="">`;
  return `
    <div class="hrow">
      <div class="col-img">${img}</div>
      <div class="col-main">
        <div class="name"><a href="${r.product_url}" target="_blank" rel="noopener">${r.product_name || '(No title)'}</a></div>
        <div class="brand">${r.brand_guess || ''}</div>
      </div>
      <div class="col-tags"><div class="tags">${tags.join(' ')}</div></div>
      <div class="pricebox">
        <div class="price">${priceView(r.price)}</div>
        ${mrp}
        <a class="open" href="${r.product_url}" target="_blank" rel="noopener">Open</a>
      </div>
    </div>
  `;
}

function renderActiveList(){
  const src = rows.filter(r=> r.category === activeCat);
  const term = ($('#search').value||'').toLowerCase();
  filtered = src.filter(r => !term || (r.product_name||'').toLowerCase().includes(term));
  $('#listActive').innerHTML = filtered.map(hRow).join('');
  $('#totalCount').textContent = `${rows.length} items total • ${src.length} in "${labelFor(activeCat)}"`;
}

function sortActive(mode){
  const key = {
    discount: (r)=> (r.discount_percent==null ? -Infinity : r.discount_percent),
    lowest:   (r)=> (r.price==null ? Infinity : r.price) * -1,
    highest:  (r)=> (r.price==null ? -Infinity : r.price),
    reviews:  (r)=> (r.review_count==null ? -Infinity : r.review_count),
    bought:   (r)=> (r.bought_past_month==null ? -Infinity : r.bought_past_month),
  }[mode];
  if (!key) return;
  const arr = filtered.slice().sort((a,b)=> key(b)-key(a));
  if (mode==='lowest') arr.reverse();
  filtered = arr;
  $('#listActive').innerHTML = filtered.map(hRow).join('');
}

/* ---------- SECOND PANE: tables ---------- */
function buildTable(cat, tableId, countId){
  const data = rows.filter(r=> r.category===cat);
  const sorted = data.slice().sort((a,b)=>{
    const A = a.bought_past_month ?? -1, B = b.bought_past_month ?? -1;
    if (B!==A) return B-A;
    const Ar = a.review_count ?? -1, Br = b.review_count ?? -1;
    return Br - Ar;
  }).slice(0, 20);

  const html = `
    <thead><tr>
      <th>#</th><th>Brand</th><th>Model</th><th>Price</th><th>Discount</th><th>Bought (month)</th>
    </tr></thead>
    <tbody>${sorted.map((r,i)=>`
      <tr>
        <td>${i+1}</td>
        <td>${r.brand_guess || '—'}</td>
        <td><a href="${r.product_url}" target="_blank" rel="noopener">${modelFromName(r.product_name)}</a></td>
        <td>${priceView(r.price)}</td>
        <td>${pctView(r.discount_percent)}</td>
        <td>${boughtView(r.bought_past_month)}</td>
      </tr>
    `).join('')}</tbody>
  `;
  $(tableId).innerHTML = html;
  $(countId).textContent = `${data.length} items`;
}
function renderTables(){
  buildTable('mobiles', '#tbl_mobiles', '#count_mobiles');
  buildTable('mobile_accessories', '#tbl_mobile_accessories', '#count_mobile_accessories');
  buildTable('laptops', '#tbl_laptops', '#count_laptops');
  buildTable('laptop_accessories', '#tbl_laptop_accessories', '#count_laptop_accessories');
}

/* ---------- CSV Export ---------- */
function toCsvRow(vals){ return vals.map(v=>{
  if (v==null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
}).join(','); }

function downloadCsv(filename, rows){
  const blob = new Blob([rows.join('\n')], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 0);
}

function buildCsvFromItems(items, addCategory = true){
  const header = ['Brand','Model','Price','Discount','Bought (month)','URL'];
  if (addCategory) header.unshift('Category');
  const out = [toCsvRow(header)];
  for (const r of items){
    const row = [
      r.brand_guess || '',
      modelFromName(r.product_name),
      r.price ?? '',
      r.discount_percent ?? '',
      r.bought_past_month ?? '',
      r.product_url || ''
    ];
    if (addCategory) row.unshift(labelFor(r.category));
    out.push(toCsvRow(row));
  }
  return out;
}

function exportCurrentTabCsv(){
  const items = filtered.length ? filtered : rows.filter(r=> r.category===activeCat);
  const csv = buildCsvFromItems(items, /*addCategory*/ false);
  const fname = `amazon_${activeCat}_list.csv`;
  downloadCsv(fname, csv);
}

function exportInsightsCsv(){
  const cats = ['mobiles','mobile_accessories','laptops','laptop_accessories'];
  const items = rows.filter(r=> cats.includes(r.category));
  const csv = buildCsvFromItems(items, /*addCategory*/ true);
  downloadCsv('amazon_insights_all.csv', csv);
}

/* ---------- Debug ---------- */
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

/* ---------- Fetch helpers ---------- */
function baseParams(){
  const params = new URLSearchParams();
  const pages = String(Math.max(1, Math.min(3, parseInt($('#maxPages').value || '2', 10) || 2)));
  const perList = String(Math.max(6, Math.min(60, parseInt($('#perListLimit').value || '16', 10) || 16)));
  const timeoutMs = String(Math.max(3000, parseInt($('#timeoutMs').value || '12000', 10) || 12000));
  params.set('max_pages', pages);
  params.set('per_list_limit', perList);
  params.set('timeout_ms', timeoutMs);
  if ($('#dbg')?.checked) params.set('debug', '1');
  if ($('#dbgshot')?.checked) params.set('debug_shot', '1');
  return params;
}

async function fetchCategory(cat){
  const fnUrl = new URL('/.netlify/functions/scrape', window.location.origin);
  const p = baseParams();
  p.set('category', cat);
  p.forEach((v,k)=> fnUrl.searchParams.set(k,v));

  const res = await fetch(fnUrl.toString(), { method: 'GET' });
  const data = await res.json().catch(()=> ({}));
  if (!res.ok || data.ok === false) throw new Error((data && (data.error||data.message)) || `HTTP ${res.status}`);
  if (data && (data.debug || data.debug_screenshot)) showDebug(data.debug, data.debug_screenshot);
  return (data.rows || []).map(r => ({ ...r, category: cat }));
}

async function fetchCustom(url){
  const fnUrl = new URL('/.netlify/functions/scrape', window.location.origin);
  const p = baseParams();
  p.set('amazon_url', url);
  p.forEach((v,k)=> fnUrl.searchParams.set(k,v));
  const res = await fetch(fnUrl.toString(), { method: 'GET' });
  const data = await res.json().catch(()=> ({}));
  if (!res.ok || data.ok === false) throw new Error((data && (data.error||data.message)) || `HTTP ${res.status}`);
  if (data && (data.debug || data.debug_screenshot)) showDebug(data.debug, data.debug_screenshot);
  return (data.rows || []).map(r => ({ ...r, category: 'custom' }));
}

function setStatus(items){
  const row = $('#statusRow');
  if (!items || !items.length){ row.style.display='none'; row.innerHTML=''; return; }
  row.style.display='flex';
  row.innerHTML = items.map(([label, state]) => `<span class="chip">${label}: ${state}</span>`).join(' ');
}

/* ---------- Run ---------- */
async function run(){
  const mode = $('#mode').value;
  const btn = $('#run');
  btn.disabled = true; btn.textContent = 'Fetching…';
  showDebug(); setStatus([]);

  try {
    rows = [];

    if (mode === 'custom') {
      const url = ($('#amazonUrl').value || '').trim();
      if (!url) { alert('Please enter a valid Amazon listing URL.'); return; }
      const part = await fetchCustom(url);
      rows = part;
      activeCat = 'custom';
      $$('.tab').forEach(x => x.classList.remove('active'));
    } else if (mode.startsWith('single_')) {
      const cat = mode.replace('single_','');
      setStatus([[labelFor(cat), 'running']]);
      const part = await fetchCategory(cat);
      rows = part;
      activeCat = cat;
      $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.cat === cat));
      setStatus([[labelFor(cat), `done (${part.length})`]]);
    } else {
      const cats = ['mobiles','mobile_accessories','laptops','laptop_accessories'];
      setStatus(cats.map(c=>[labelFor(c), 'queued']));
      const tasks = cats.map(async (c, idx) => {
        setStatus(cats.map((x,i)=>[labelFor(x), i===idx?'running':(rows.some(r=>r.category===x)?'done':'queued')]));
        try {
          const part = await fetchCategory(c);
          rows = rows.concat(part);
          setStatus(cats.map((x)=>[labelFor(x), rows.some(r=>r.category===x)?`done (${rows.filter(r=>r.category===x).length})`:'queued']));
        } catch (e) {
          console.error('Category failed', c, e);
          setStatus(cats.map((x)=>[labelFor(x), x===c?`error`: (rows.some(r=>r.category===x)?`done (${rows.filter(r=>r.category===x).length})`:'queued')]));
        }
      });
      await Promise.allSettled(tasks);
      activeCat = 'mobiles';
      $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.cat === 'mobiles'));
    }

    renderActiveList();
    renderTables();
  } catch (err) {
    console.error('Fetch failed:', err);
    alert('Fetch failed: ' + (err?.message || err));
  } finally {
    setStatus([]);
    btn.disabled = false; btn.textContent = 'Fetch';
  }
}

/* ---------- Events ---------- */
document.addEventListener('DOMContentLoaded', () => {
  $('#run').addEventListener('click', run);
  $('#exportTabCsv').addEventListener('click', exportCurrentTabCsv);
  $('#exportInsightsCsv').addEventListener('click', exportInsightsCsv);
  $('#search').addEventListener('input', renderActiveList);
  $$('.pill').forEach(p => p.addEventListener('click', ()=> sortActive(p.dataset.sort)));
  $$('.tab').forEach(t => {
    t.addEventListener('click', () => {
      $$('.tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      activeCat = t.dataset.cat;
      renderActiveList();
    });
  });
  $('#mode').addEventListener('change', ()=> {
    const isCustom = $('#mode').value === 'custom';
    $('#amazonUrl').style.display = isCustom ? '' : 'none';
  });
});
