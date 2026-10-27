/* app.js — screens and wiring for Store POS (offline PWA). */
(function () {
  'use strict';
  const APP_VERSION = '1.1.0';
  const DAY = 86400000;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const ico = (n) => `<svg class="ic" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) % 360; return h; };
  const avatar = (name) => `<div class="av" style="--h:${hue(name)}" aria-hidden="true">${esc((String(name).trim()[0] || '?').toUpperCase())}</div>`;

  const state = {
    items: [], itemsById: new Map(), byBarcode: new Map(),
    cart: [], tab: 'sell', range: 'today', invFilter: 'all',
    settings: { storeName: 'My Grocery Store', currency: '₱', firstUseAt: Date.now(), lastBackupAt: 0 },
    installPrompt: null, histSales: new Map()
  };
  const money = (c) => Core.formatMoney(c, state.settings.currency);
  const dealTag = (o) => Core.dealApplies(o.priceCents, o.bundleQty, o.bundlePriceCents)
    ? `<span class="deal">${o.bundleQty} for ${money(o.bundlePriceCents)}</span>` : '';

  /* ---------------- toast & dialog ---------------- */
  const toastEl = $('#toast');
  const hasPopover = 'showPopover' in HTMLElement.prototype;
  if (!hasPopover) { toastEl.removeAttribute('popover'); toastEl.hidden = true; }
  function toast(msg, ms) {
    toastEl.textContent = msg;
    try {
      if (hasPopover) { if (toastEl.matches(':popover-open')) toastEl.hidePopover(); toastEl.showPopover(); }
      else toastEl.hidden = false;
    } catch (e) { /* ignore */ }
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { try { hasPopover ? toastEl.hidePopover() : (toastEl.hidden = true); } catch (e) {} }, ms || 2200);
  }

  const dlg = $('#dlg');
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDialog(); }); // tap on the dimmed area
  function openDialog(html) {
    dlg.innerHTML = html;
    if (!dlg.open) dlg.showModal();
    $$('[data-close]', dlg).forEach((b) => b.addEventListener('click', closeDialog));
    return dlg;
  }
  function closeDialog() { if (dlg.open) dlg.close(); }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
  const fmtDateTime = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const isoDate = (ts) => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const lineAmount = (l) => (l.totalCents != null ? l.totalCents : l.priceCents * l.qty); // old sales have no totalCents

  /* ---------------- data ---------------- */
  async function loadItems() {
    state.items = (await Store.allItems()).sort((a, b) => a.name.localeCompare(b.name));
    state.itemsById = new Map(state.items.map((i) => [i.id, i]));
    state.byBarcode = new Map(state.items.filter((i) => i.barcode).map((i) => [i.barcode, i]));
    // keep cart prices, names and deals in sync with edits made to items
    state.cart = state.cart.map((l) => {
      const it = l.itemId && state.itemsById.get(l.itemId);
      return it ? Object.assign({}, l, { name: it.name, priceCents: it.priceCents, costCents: it.costCents || 0,
        bundleQty: it.bundleQty || 0, bundlePriceCents: it.bundlePriceCents || 0 }) : l;
    });
  }
  async function saveSettings() { await Store.saveSettings(state.settings); }

  /* ---------------- tabs & header ---------------- */
  function showTab(name) {
    state.tab = name;
    ['sell', 'inv', 'hist', 'more'].forEach((t) => { $('#view-' + t).hidden = t !== name; });
    $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    $('#checkoutBar').hidden = name !== 'sell';
    document.body.classList.toggle('has-dock', name === 'sell');
    renderDate();
    if (name === 'sell') renderSell();
    if (name === 'inv') renderInv();
    if (name === 'hist') renderHistory();
    if (name === 'more') renderMore();
    window.scrollTo(0, 0);
  }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  function renderDate() { $('#todayDate').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }); }
  function renderHeader() {
    $('#storeName').textContent = state.settings.storeName || 'Store POS';
    document.title = state.settings.storeName || 'Store POS';
  }
  function renderNet() {
    const on = navigator.onLine, b = $('#netBadge');
    $('b', b).textContent = on ? 'Online' : 'Offline';
    b.classList.toggle('off', !on);
  }
  window.addEventListener('online', renderNet);
  window.addEventListener('offline', renderNet);

  /* =========================================================
     SELL
     ========================================================= */
  const stockOf = (l) => { const it = l.itemId && state.itemsById.get(l.itemId); return it ? it.stock : null; };

  function renderSell() {
    const cart = $('#cart');
    if (!state.cart.length) {
      cart.innerHTML = `<div class="empty"><div class="ring">${ico('bag')}</div><strong>Nothing in the cart yet</strong>Scan an item or search by name to start a sale.</div>`;
    } else {
      cart.innerHTML = state.cart.map((l) => {
        const st = stockOf(l);
        const total = Core.cartLineTotal(l);
        const saved = l.priceCents * l.qty - total;
        const one = l.qty === 1;
        const sub = `<span>${money(l.priceCents)} each</span>${dealTag(l)}${saved > 0 ? `<span class="saved">Saved ${money(saved)}</span>` : ''}`
          + `${l.custom ? '<span>Quick item</span>' : ''}${st !== null && l.qty > st ? `<span class="warn">Only ${st} in stock</span>` : ''}`;
        return `<div class="line" data-key="${esc(l.key)}">${avatar(l.name)}
          <div class="l-name">${esc(l.name)}</div><div class="l-total">${money(total)}</div>
          <div class="l-sub">${sub}</div>
          <div class="stepper">
            <button data-act="dec" class="${one ? 'rm' : ''}" aria-label="${one ? 'Remove from cart' : 'Decrease quantity'}">${ico(one ? 'trash' : 'minus')}</button>
            <button data-act="qty" class="qty" aria-label="Change quantity">${l.qty}</button>
            <button data-act="inc" aria-label="Increase quantity">${ico('plus')}</button>
          </div></div>`;
      }).join('');
    }
    const total = Core.cartTotal(state.cart), savings = Core.cartSavings(state.cart), u = Core.cartUnits(state.cart);
    $('#cartTotal').textContent = money(total);
    $('#cartCount').textContent = u + (u === 1 ? ' item' : ' items') + (savings > 0 ? `, saved ${money(savings)}` : '');
    $('#chargeBtn').disabled = !state.cart.length;
    renderBackupBanner();
  }

  function renderBackupBanner() {
    const last = state.settings.lastBackupAt || state.settings.firstUseAt || 0;
    $('#backupBanner').hidden = !(state.items.length > 0 && Date.now() - last > 7 * DAY);
  }
  $('#backupBanner').addEventListener('click', () => { showTab('more'); $('#backupCard').scrollIntoView(); });

  function addToCart(item, qty) {
    state.cart = Core.cartAdd(state.cart, item, qty || 1);
    renderSell();
    const line = state.cart.find((l) => l.itemId === item.id);
    if (line && line.qty > item.stock) toast(`Only ${item.stock} of ${item.name} in stock`);
  }

  function searchItems(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return state.items.filter((i) => {
      const hay = (i.name + ' ' + (i.barcode || '')).toLowerCase();
      return words.every((w) => hay.includes(w));
    }).slice(0, 8);
  }
  function renderResults() {
    const q = $('#sellInput').value.trim();
    const box = $('#sellResults');
    if (!q) { box.hidden = true; box.innerHTML = ''; return; }
    const res = searchItems(q);
    box.hidden = false;
    box.innerHTML = res.length
      ? res.map((i) => `<button type="button" class="res" data-id="${esc(i.id)}">${avatar(i.name)}<span class="r-main"><span class="r-name">${esc(i.name)}</span>
          <span class="r-sub"><span>${money(i.priceCents)}</span>${dealTag(i)}<span>${i.stock} left</span></span></span>${ico('plus')}</button>`).join('')
      : '<div class="empty small">No match. Check the spelling, or add it in Inventory.</div>';
  }
  $('#sellInput').addEventListener('input', debounce(renderResults, 80));
  $('#sellResults').addEventListener('click', (e) => {
    const b = e.target.closest('.res'); if (!b) return;
    const it = state.itemsById.get(b.dataset.id);
    if (it) { addToCart(it); $('#sellInput').value = ''; renderResults(); }
  });
  // Enter key: also what a USB/Bluetooth barcode scanner sends after the digits.
  $('#sellForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = $('#sellInput').value.trim();
    if (!raw) return;
    const code = Core.canonBarcode(raw);
    const hit = state.byBarcode.get(code);
    const input = $('#sellInput');
    if (hit) { addToCart(hit); input.value = ''; renderResults(); return; }
    const res = searchItems(raw);
    if (res.length === 1) { addToCart(res[0]); input.value = ''; renderResults(); }
    else if (/^\d{6,}$/.test(code)) { input.value = ''; renderResults(); offerAddUnknown(code); }
    else if (!res.length) toast('No matching item');
  });

  function offerAddUnknown(code) {
    openDialog(`<div class="sheet"><h2>Item not in inventory</h2>
      <p class="muted">The barcode <strong>${esc(code)}</strong> isn't registered yet.</p>
      <div class="actions"><button class="btn" data-close>Cancel</button><span class="grow"></span>
      <button class="btn tag" id="addUnknown">Add this item</button></div></div>`);
    $('#addUnknown', dlg).onclick = () => itemForm(null, code, false);
  }

  function scanForSale() {
    return Scanner.open({
      title: 'Scan items to sell', continuous: true,
      onCode: async (code, ctl) => {
        const it = state.byBarcode.get(code);
        if (!it) { ctl.close(); offerAddUnknown(code); return; }
        addToCart(it);
        const line = state.cart.find((l) => l.itemId === it.id);
        ctl.setStatus(`Added ${it.name}. Quantity ${line.qty}, cart ${money(Core.cartTotal(state.cart))}`);
      }
    });
  }
  $('#sellScan').addEventListener('click', scanForSale);

  $('#cart').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const key = btn.closest('.line').dataset.key;
    const line = state.cart.find((l) => l.key === key); if (!line) return;
    const act = btn.dataset.act;
    if (act === 'inc') state.cart = Core.cartSetQty(state.cart, key, line.qty + 1);
    else if (act === 'dec') state.cart = Core.cartSetQty(state.cart, key, line.qty - 1);
    else if (act === 'qty') return qtyDialog(line);
    renderSell();
  });

  function qtyDialog(line) {
    openDialog(`<form class="sheet" id="qtyForm" novalidate><h2>${esc(line.name)}</h2>
      <label class="fld">Quantity <input name="qty" inputmode="numeric" value="${line.qty}" autocomplete="off"></label>
      <p class="error" id="qtyErr" role="alert"></p>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><span class="grow"></span><button class="btn solid">Update</button></div></form>`);
    const f = $('#qtyForm', dlg); f.elements.qty.select();
    f.onsubmit = (e) => {
      e.preventDefault();
      const n = Core.toCount(f.elements.qty.value);
      if (!Number.isInteger(n)) { $('#qtyErr', dlg).textContent = 'Enter a whole number.'; return; }
      state.cart = Core.cartSetQty(state.cart, line.key, n);
      renderSell(); closeDialog();
    };
  }

  $('#quickBtn').addEventListener('click', () => {
    openDialog(`<form class="sheet" id="quickForm" novalidate><h2>Quick item</h2>
      <p class="muted">For something that isn't in your inventory. Stock isn't tracked.</p>
      <label class="fld" style="margin-top:12px">Description <input name="name" placeholder="Loose candy" autocomplete="off"></label>
      <div class="grid2"><label class="fld">Price each <input name="price" inputmode="decimal" autocomplete="off"></label>
      <label class="fld">Quantity <input name="qty" inputmode="numeric" value="1" autocomplete="off"></label></div>
      <p class="error" id="quickErr" role="alert"></p>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><span class="grow"></span><button class="btn solid">Add to cart</button></div></form>`);
    const f = $('#quickForm', dlg); f.elements.price.focus();
    f.onsubmit = (e) => {
      e.preventDefault();
      const price = Core.toCents(f.elements.price.value), qty = Core.toCount(f.elements.qty.value);
      if (!Number.isFinite(price) || price <= 0) { $('#quickErr', dlg).textContent = 'Enter a price greater than 0.'; return; }
      if (!Number.isInteger(qty) || qty < 1) { $('#quickErr', dlg).textContent = 'Quantity must be 1 or more.'; return; }
      state.cart = Core.cartAddCustom(state.cart, f.elements.name.value, price, qty);
      renderSell(); closeDialog();
    };
  });

  $('#chargeBtn').addEventListener('click', checkoutDialog);

  function checkoutDialog() {
    if (!state.cart.length) return;
    const total = Core.cartTotal(state.cart), savings = Core.cartSavings(state.cart);
    const short = Core.stockShortfalls(state.cart, state.itemsById);
    const bills = [20, 50, 100, 200, 500, 1000].filter((b) => b * 100 >= total).slice(0, 4);
    openDialog(`<form class="sheet" id="payForm" novalidate>
      <h2 class="center">Charge</h2>
      <div class="bigtotal">${money(total)}</div>
      <div class="bigtotal-sub">${savings > 0 ? `Deals saved ${money(savings)}` : ''}</div>
      ${short.length ? `<p class="notice">Not enough stock recorded for ${short.map((s) => esc(s.name) + ' (' + s.stock + ' left)').join(', ')}. You can still sell it. Stock stops at 0.</p>` : ''}
      <label class="fld">Amount received <input name="paid" inputmode="decimal" autocomplete="off" placeholder="${(total / 100).toFixed(2)}"></label>
      <div class="pay-chips"><button type="button" class="pill" data-amt="${total}">Exact</button>${bills.map((b) => `<button type="button" class="pill" data-amt="${b * 100}">${esc(state.settings.currency)}${b}</button>`).join('')}</div>
      <div class="changebox">Change <strong id="changeVal">${money(0)}</strong></div>
      <p class="error" id="payErr" role="alert"></p>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><span class="grow"></span><button class="btn tag big" id="payOk">Save sale</button></div></form>`);
    const f = $('#payForm', dlg), paidEl = f.elements.paid;
    const paidCents = () => { const v = paidEl.value.trim(); return v === '' ? total : Core.toCents(v); };
    const update = () => {
      const p = paidCents(), ok = Number.isFinite(p) && p >= total;
      $('#changeVal', dlg).textContent = ok ? money(p - total) : '—';
      $('#payErr', dlg).textContent = ok || paidEl.value.trim() === '' ? '' : (Number.isFinite(p) ? `Short by ${money(total - p)}` : 'Enter a valid amount.');
      $('#payOk', dlg).disabled = !ok;
    };
    paidEl.addEventListener('input', update);
    $$('.pill', dlg).forEach((c) => c.addEventListener('click', () => { paidEl.value = (Number(c.dataset.amt) / 100).toFixed(2); update(); }));
    update();
    let saving = false;
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (saving) return;
      const p = paidCents();
      if (!Number.isFinite(p) || p < total) return;
      saving = true; $('#payOk', dlg).disabled = true;
      try {
        const sale = Core.buildSale(state.cart, { paidCents: p });
        await Store.recordSale(sale);
        state.cart = [];
        await loadItems();
        renderSell(); renderInvIfVisible();
        saleDone(sale);
      } catch (err) {
        saving = false; $('#payOk', dlg).disabled = false;
        $('#payErr', dlg).textContent = 'Could not save the sale: ' + (err && err.message || err);
      }
    };
  }

  function saleDone(sale) {
    const low = [];
    sale.lines.forEach((l) => {
      const it = l.itemId && state.itemsById.get(l.itemId);
      if (it && it.stock <= it.lowStock) low.push(`${it.name} (${it.stock} left)`);
    });
    openDialog(`<div class="sheet center"><div class="check-ok">${ico('check')}</div><h2>Sale saved</h2>
      <p class="muted">Total ${money(sale.totalCents)}, received ${money(sale.paidCents)}</p>
      <div class="changebox big">Give change<strong>${money(sale.changeCents)}</strong></div>
      ${low.length ? `<p class="notice">Running low: ${low.map(esc).join(', ')}</p>` : ''}
      <div class="actions"><span class="grow"></span><button class="btn solid big" data-close>New sale</button><span class="grow"></span></div></div>`);
  }

  /* =========================================================
     INVENTORY
     ========================================================= */
  function renderInvIfVisible() { if (state.tab === 'inv') renderInv(); }

  function renderInv() {
    const q = $('#invSearch').value.trim();
    let low = 0, out = 0, value = 0;
    state.items.forEach((i) => {
      if (i.stock === 0) out++; else if (i.stock <= i.lowStock) low++;
      value += (i.costCents || 0) * i.stock;
    });
    $('#invStats').innerHTML = [
      ['Items', state.items.length, ''], ['Stock value at cost', money(value), ''],
      ['Running low', low, low ? 'warn' : ''], ['Out of stock', out, out ? 'bad' : '']
    ].map((s) => `<div class="stat ${s[2]}"><span>${esc(s[0])}</span><strong>${esc(s[1])}</strong></div>`).join('');
    $$('#invFilter button').forEach((b) => b.classList.toggle('on', b.dataset.f === state.invFilter));

    let list = state.items;
    if (q) {
      const words = q.toLowerCase().split(/\s+/);
      list = list.filter((i) => { const h = (i.name + ' ' + (i.barcode || '')).toLowerCase(); return words.every((w) => h.includes(w)); });
    }
    if (state.invFilter === 'low') list = list.filter((i) => i.stock > 0 && i.stock <= i.lowStock);
    if (state.invFilter === 'out') list = list.filter((i) => i.stock === 0);
    const total = list.length;
    list = list.slice(0, 300);
    $('#invList').innerHTML = !state.items.length
      ? `<div class="empty"><div class="ring">${ico('box')}</div><strong>No items yet</strong>Tap Scan to scan a barcode, or Add to type an item in.</div>`
      : !total ? '<div class="empty small">No items match.</div>'
      : list.map((i) => {
        const cls = i.stock === 0 ? 'out' : i.stock <= i.lowStock ? 'low' : '';
        return `<div class="row" data-id="${esc(i.id)}">${avatar(i.name)}<div class="r-main"><div class="r-name">${esc(i.name)}</div>
          <div class="r-sub"><span>${money(i.priceCents)}</span>${dealTag(i)}<span>${esc(i.barcode || 'No barcode')}</span></div></div>
          <span class="stock ${cls}" title="In stock">${i.stock}</span>
          <button class="chip" data-act="restock" aria-label="Add stock to ${esc(i.name)}">${ico('plus')}</button></div>`;
      }).join('') + (total > 300 ? `<div class="empty small">Showing 300 of ${total}. Narrow your search.</div>` : '');
  }
  $('#invSearch').addEventListener('input', debounce(renderInv, 80));
  $('#invFilter').addEventListener('click', (e) => { const b = e.target.closest('button[data-f]'); if (!b) return; state.invFilter = b.dataset.f; renderInv(); });
  $('#invList').addEventListener('click', (e) => {
    const row = e.target.closest('.row'); if (!row) return;
    const it = state.itemsById.get(row.dataset.id); if (!it) return;
    if (e.target.closest('[data-act="restock"]')) restockForm(it, false); else itemForm(it, '', false);
  });
  $('#invAdd').addEventListener('click', () => itemForm(null, '', false));
  $('#invScan').addEventListener('click', scanInventory);

  function scanInventory() {
    return Scanner.open({
      title: 'Scan to add or restock', continuous: false,
      onCode: async (code, ctl) => {
        ctl.close();
        const it = state.byBarcode.get(code);
        if (it) restockForm(it, true); else itemForm(null, code, true);
      }
    });
  }

  function itemForm(item, prefillBarcode, fromScan) {
    const isNew = !item;
    const v = item || { name: '', barcode: prefillBarcode || '', priceCents: NaN, costCents: 0, stock: 0, lowStock: 5, bundleQty: 0, bundlePriceCents: 0 };
    const hasDeal = v.bundleQty > 1 && v.bundlePriceCents > 0;
    openDialog(`<form class="sheet" id="itemForm" novalidate autocomplete="off">
      <h2>${isNew ? 'Add item' : 'Edit item'}</h2>
      <label class="fld" style="margin-top:12px">Barcode (optional)<div class="inline"><input name="barcode" value="${esc(v.barcode || '')}" placeholder="Scan or type" inputmode="text">
        <button type="button" class="btn" id="scanInto">${ico('scan')}Scan</button></div></label>
      <label class="fld">Name <input name="name" value="${esc(v.name)}" maxlength="80" placeholder="Rice 1kg"></label>
      <div class="grid2">
        <label class="fld">Price each <input name="price" inputmode="decimal" value="${Number.isFinite(v.priceCents) ? (v.priceCents / 100).toFixed(2) : ''}"></label>
        <label class="fld">Cost each <input name="cost" inputmode="decimal" value="${v.costCents ? (v.costCents / 100).toFixed(2) : ''}" placeholder="Optional"></label>
      </div>
      <div class="dealbox">
        <h4><span class="deal">Deal</span> Multi-buy price (optional)</h4>
        <p class="hint">Sell candy at 2.00 each, or 3 for 5.00. Leave blank for no deal.</p>
        <div class="deal-row"><input name="dealQty" inputmode="numeric" placeholder="3" value="${hasDeal ? v.bundleQty : ''}" aria-label="Number of items in the deal"><span>for</span>
          <input name="dealPrice" inputmode="decimal" placeholder="5.00" value="${hasDeal ? (v.bundlePriceCents / 100).toFixed(2) : ''}" aria-label="Deal price"></div>
        <p class="preview" id="dealPreview" aria-live="polite"></p>
      </div>
      <div class="grid2">
        <label class="fld">In stock <input name="stock" inputmode="numeric" value="${v.stock}"></label>
        <label class="fld">Warn me at <input name="low" inputmode="numeric" value="${v.lowStock}"></label>
      </div>
      <p class="error" id="itemErr" role="alert"></p>
      <div class="actions">
        ${isNew ? '' : `<button type="button" class="btn danger" id="delItem" aria-label="Delete item">${ico('trash')}</button>`}
        <span class="grow"></span><button type="button" class="btn" data-close>Cancel</button>
        <button class="btn solid" value="save">Save</button>
        ${fromScan && isNew ? '<button class="btn tag" value="next">Save and scan next</button>' : ''}
      </div></form>`);
    const f = $('#itemForm', dlg), err = $('#itemErr', dlg), el = f.elements;
    if (isNew) (el.barcode.value ? el.name : el.barcode).focus();

    const preview = () => {
      const p = Core.toCents(el.price.value), q = Core.toCount(el.dealQty.value), dp = Core.toCents(el.dealPrice.value);
      const box = $('#dealPreview', dlg);
      if (!el.dealQty.value.trim() || !el.dealPrice.value.trim() || !Number.isFinite(p) || !Number.isInteger(q) || q < 2 || !Number.isFinite(dp)) { box.textContent = ''; return; }
      if (!Core.dealApplies(p, q, dp)) { box.textContent = `Not cheaper than ${money(p)} each. Lower the deal price.`; return; }
      box.textContent = [1, q, q + 1, q * 2].map((n) => `${n} = ${money(Core.lineTotal(p, n, q, dp))}`).join(',  ');
    };
    ['price', 'dealQty', 'dealPrice'].forEach((n) => el[n].addEventListener('input', preview));
    preview();

    $('#scanInto', dlg).onclick = () => Scanner.open({
      title: 'Scan barcode', continuous: false,
      onCode: async (code, ctl) => {
        ctl.close(); el.barcode.value = code;
        const other = state.byBarcode.get(code);
        err.textContent = other && (!item || other.id !== item.id) ? `Already used by ${other.name}.` : '';
        el.name.focus();
      }
    });
    if (!isNew) $('#delItem', dlg).onclick = async () => {
      if (!confirm(`Delete ${item.name}? Past sales keep their records.`)) return;
      await Store.deleteItem(item.id); await loadItems(); renderInv(); renderSell(); closeDialog(); toast('Item deleted');
    };

    let saving = false;
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (saving) return;
      const goNext = e.submitter && e.submitter.value === 'next';
      const barcode = Core.canonBarcode(el.barcode.value);
      const dq = el.dealQty.value.trim(), dp = el.dealPrice.value.trim();
      const data = {
        name: el.name.value.trim(), priceCents: Core.toCents(el.price.value),
        costCents: el.cost.value.trim() ? Core.toCents(el.cost.value) : 0,
        stock: Core.toCount(el.stock.value), lowStock: Core.toCount(el.low.value),
        bundleQty: dq || dp ? Core.toCount(dq) : 0,
        bundlePriceCents: dq || dp ? (dp ? Core.toCents(dp) : 0) : 0
      };
      const errs = Core.validateItem(data);
      if (!errs.length && barcode) {
        const other = state.byBarcode.get(barcode);
        if (other && (!item || other.id !== item.id)) errs.push(`That barcode is already used by ${other.name}.`);
      }
      if (errs.length) { err.textContent = errs[0]; return; }
      const now = Date.now();
      const rec = Object.assign({ id: item ? item.id : Core.uid() }, data, barcode ? { barcode } : {},
        { createdAt: item ? item.createdAt : now, updatedAt: now });
      saving = true;
      try { await Store.saveItem(rec); }
      catch (ex) { saving = false; err.textContent = ex.message || 'Could not save.'; return; }
      await loadItems(); renderInv(); renderSell(); closeDialog();
      toast(isNew ? `Added ${rec.name}` : 'Item saved');
      if (goNext) scanInventory();
    };
  }

  function restockForm(item, fromScan) {
    openDialog(`<form class="sheet" id="stockForm" novalidate>
      <h2>Add stock</h2>
      <div style="display:flex;gap:12px;align-items:center;margin:8px 0 14px">${avatar(item.name)}<div><strong>${esc(item.name)}</strong><br><span class="muted">${item.stock} in stock now</span></div></div>
      <label class="fld">Quantity received <input name="qty" inputmode="numeric" value="1" autocomplete="off"></label>
      <p class="error" id="stockErr" role="alert"></p>
      <div class="actions"><button type="button" class="btn" id="editInstead">Edit item</button><span class="grow"></span>
        <button type="button" class="btn" data-close>Cancel</button>
        <button class="btn solid" value="save">Add stock</button>
        ${fromScan ? '<button class="btn tag" value="next">Add and scan next</button>' : ''}</div></form>`);
    const f = $('#stockForm', dlg); f.elements.qty.select();
    $('#editInstead', dlg).onclick = () => itemForm(item, '', false);
    let saving = false;
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (saving) return;
      const goNext = e.submitter && e.submitter.value === 'next';
      const n = Core.toCount(f.elements.qty.value);
      if (!Number.isInteger(n) || n < 1) { $('#stockErr', dlg).textContent = 'Enter a whole number, 1 or more.'; return; }
      saving = true;
      try { const u = await Store.adjustStock(item.id, n); await loadItems(); renderInv(); renderSell(); closeDialog(); toast(`${u.name}: now ${u.stock} in stock`); }
      catch (ex) { saving = false; $('#stockErr', dlg).textContent = ex.message; return; }
      if (goNext) scanInventory();
    };
  }

  /* =========================================================
     SALES HISTORY
     ========================================================= */
  function rangeFrom(r) {
    const now = Date.now();
    return r === 'today' ? Core.dayStart(now) : r === 'week' ? Core.dayStart(now - 6 * DAY) : r === 'month' ? Core.dayStart(now - 29 * DAY) : 0;
  }
  async function renderHistory() {
    const from = rangeFrom(state.range);
    const sales = await Store.salesSince(from);
    const s = Core.summarize(sales, from, null);
    $('#histStats').innerHTML =
      `<div class="stat hero"><span>Revenue</span><strong>${money(s.revenue)}</strong></div>` +
      `<div class="stat good"><span>Estimated profit</span><strong>${money(s.profit)}</strong></div>` +
      `<div class="stat"><span>Sales, ${s.units} items</span><strong>${s.count}</strong></div>`;
    const shown = sales.slice(0, 200);
    $('#histList').innerHTML = !sales.length
      ? `<div class="empty"><div class="ring">${ico('receipt')}</div><strong>No sales in this period</strong>Sales you save will show up here.</div>`
      : shown.map((sl) => {
        const units = sl.lines.reduce((n, l) => n + l.qty, 0);
        return `<button class="row sale ${sl.voidedAt ? 'void' : ''}" data-id="${esc(sl.id)}"><div class="sale-ic">${ico('receipt')}</div><div class="r-main"><div class="r-name">${esc(fmtDateTime(sl.ts))}</div>
          <div class="r-sub"><span>${units} item${units === 1 ? '' : 's'}</span>${sl.voidedAt ? '<span class="tag-void">Voided</span>' : ''}</div></div><strong>${money(sl.totalCents)}</strong></button>`;
      }).join('') + (sales.length > 200 ? '<div class="empty small">Showing the latest 200 sales.</div>' : '');
    state.histSales = new Map(sales.map((x) => [x.id, x]));
  }
  $('#histRange').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]'); if (!b) return;
    state.range = b.dataset.range;
    $$('#histRange button').forEach((x) => x.classList.toggle('on', x === b));
    renderHistory();
  });
  $('#histList').addEventListener('click', (e) => {
    const r = e.target.closest('.sale'); if (!r) return;
    const sale = state.histSales.get(r.dataset.id); if (sale) saleDetail(sale);
  });
  function saleDetail(sale) {
    const rows = sale.lines.map((l) => {
      const note = Core.dealApplies(l.priceCents, l.bundleQty, l.bundlePriceCents) && l.qty >= l.bundleQty ? `<small>Deal: ${l.bundleQty} for ${money(l.bundlePriceCents)}</small>` : '';
      return `<div class="drow"><span>${l.qty} × ${esc(l.name)}${note}</span><span>${money(lineAmount(l))}</span></div>`;
    }).join('');
    openDialog(`<div class="sheet"><h2>Sale ${sale.voidedAt ? '<span class="tag-void">Voided</span>' : ''}</h2>
      <p class="muted">${esc(fmtDateTime(sale.ts))}</p>
      <div class="detail">${rows}
        <div class="drow tot"><span>Total</span><span>${money(sale.totalCents)}</span></div>
        <div class="drow"><span>Received</span><span>${money(sale.paidCents)}</span></div>
        <div class="drow"><span>Change</span><span>${money(sale.changeCents)}</span></div></div>
      <div class="actions">${sale.voidedAt ? '' : '<button class="btn danger" id="voidBtn">Void sale</button>'}<span class="grow"></span><button class="btn solid" data-close>Close</button></div></div>`);
    const vb = $('#voidBtn', dlg);
    if (vb) vb.onclick = async () => {
      if (!confirm('Void this sale? The items go back into stock and the sale is left out of totals.')) return;
      await Store.voidSale(sale.id); await loadItems(); renderHistory(); renderInvIfVisible(); closeDialog(); toast('Sale voided and stock restored');
    };
  }

  /* =========================================================
     MORE (settings, backup, export)
     ========================================================= */
  async function renderMore() {
    $('#setName').value = state.settings.storeName || '';
    $('#setCur').value = state.settings.currency || '';
    const last = state.settings.lastBackupAt;
    $('#backupInfo').textContent = last
      ? `Last backup: ${fmtDateTime(last)}. Your data lives only on this phone, so back up often.`
      : 'No backup yet. Your data lives only on this phone. Download a backup and keep it somewhere safe.';
    $('#verInfo').textContent = `Store POS v${APP_VERSION}. Works fully offline.`;
    $('#btnInstall').hidden = !state.installPrompt;
    let info = '';
    try {
      if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); info += `Using ${(e.usage / 1048576).toFixed(1)} MB. `; }
      if (navigator.storage && navigator.storage.persisted) { const p = await navigator.storage.persisted(); info += p ? 'Your data is protected from automatic cleanup.' : 'The phone may clear this data if it runs very low on space.'; $('#btnPersist').hidden = p; }
    } catch (e) { /* ignore */ }
    $('#storageInfo').textContent = info;
  }
  $('#setName').addEventListener('input', debounce(async () => { state.settings.storeName = $('#setName').value.trim() || 'Store POS'; renderHeader(); await saveSettings(); }, 400));
  $('#setCur').addEventListener('input', debounce(async () => { state.settings.currency = $('#setCur').value; await saveSettings(); renderSell(); }, 400));

  $('#btnBackup').addEventListener('click', async () => {
    state.settings.lastBackupAt = Date.now();
    await saveSettings();
    const data = await Store.exportAll();
    download(`store-pos-backup-${isoDate(Date.now())}.json`, JSON.stringify(data), 'application/json');
    renderMore(); renderBackupBanner(); toast('Backup downloaded');
  });
  $('#btnRestore').addEventListener('click', () => $('#fileRestore').click());
  $('#fileRestore').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || data.app !== 'grocery-pos') throw new Error('This file is not a Store POS backup.');
      if (!confirm(`Replace ALL current data with this backup (${data.items.length} items, ${data.sales.length} sales)?`)) return;
      await Store.importAll(data);
      const s = await Store.getSettings(); if (s) Object.assign(state.settings, s);
      state.cart = []; await loadItems(); renderHeader(); renderMore(); toast('Backup restored');
    } catch (err) { alert('Could not restore: ' + (err && err.message || err)); }
  });
  $('#btnCsvInv').addEventListener('click', () => {
    const rows = [['Barcode', 'Name', 'Price', 'Cost', 'Deal quantity', 'Deal price', 'Stock', 'Low-stock alert']]
      .concat(state.items.map((i) => [i.barcode || '', i.name, (i.priceCents / 100).toFixed(2), ((i.costCents || 0) / 100).toFixed(2),
        i.bundleQty || '', i.bundlePriceCents ? (i.bundlePriceCents / 100).toFixed(2) : '', i.stock, i.lowStock]));
    download(`inventory-${isoDate(Date.now())}.csv`, '﻿' + Core.toCSV(rows), 'text/csv');
  });
  $('#btnCsvSales').addEventListener('click', async () => {
    const sales = (await Store.salesSince(0)).reverse();
    const rows = [['Date', 'Time', 'Sale ID', 'Item', 'Barcode', 'Qty', 'Unit price', 'Line total', 'Status']];
    sales.forEach((s) => {
      const d = new Date(s.ts);
      s.lines.forEach((l) => rows.push([isoDate(s.ts), d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), s.id, l.name, l.barcode || '', l.qty,
        (l.priceCents / 100).toFixed(2), (lineAmount(l) / 100).toFixed(2), s.voidedAt ? 'VOIDED' : 'OK']));
    });
    download(`sales-${isoDate(Date.now())}.csv`, '﻿' + Core.toCSV(rows), 'text/csv');
  });
  $('#btnPersist').addEventListener('click', async () => {
    try { const ok = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; toast(ok ? 'Your data is protected' : 'The browser said no. Installing the app helps.'); } catch (e) { /* ignore */ }
    renderMore();
  });
  $('#btnErase').addEventListener('click', async () => {
    if (!confirm('Erase ALL items and sales on this phone? This cannot be undone.')) return;
    const t = prompt('Type ERASE to confirm. Download a backup first if you are unsure.');
    if (t !== 'ERASE') return;
    await Store.clearAll();
    state.settings = { storeName: 'My Grocery Store', currency: '₱', firstUseAt: Date.now(), lastBackupAt: 0 };
    await saveSettings(); state.cart = []; await loadItems(); renderHeader(); renderMore(); toast('All data erased');
  });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; $('#btnInstall').hidden = false; });
  $('#btnInstall').addEventListener('click', async () => {
    const p = state.installPrompt; if (!p) return;
    p.prompt(); try { await p.userChoice; } catch (e) {}
    state.installPrompt = null; $('#btnInstall').hidden = true;
  });
  window.addEventListener('appinstalled', () => { state.installPrompt = null; $('#btnInstall').hidden = true; });

  /* ---------------- init ---------------- */
  window.addEventListener('unhandledrejection', (e) => { toast('Something went wrong: ' + ((e.reason && e.reason.message) || e.reason)); });

  async function init() {
    renderNet();
    try {
      await Store.open();
      const s = await Store.getSettings();
      if (s) Object.assign(state.settings, s); else await saveSettings();
      await loadItems();
    } catch (err) {
      $('#app').innerHTML = `<div class="empty"><strong>Storage isn't available</strong>${esc(err.message || err)}<br>Try a normal browser window, not a private one.</div>`;
      return;
    }
    renderHeader();
    showTab('sell');
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); // ask quietly for durable storage
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  init();
})();
