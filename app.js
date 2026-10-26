/* app.js — UI and wiring for Store POS (offline PWA). */
(function () {
  'use strict';
  const APP_VERSION = '1.0.0';
  const DAY = 86400000;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const state = {
    items: [], itemsById: new Map(), byBarcode: new Map(),
    cart: [], tab: 'sell', range: 'today',
    settings: { storeName: 'My Grocery Store', currency: '₱', firstUseAt: Date.now(), lastBackupAt: 0 },
    installPrompt: null
  };
  const money = (c) => Core.formatMoney(c, state.settings.currency);

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
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDialog(); }); // click on backdrop
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

  /* ---------------- data ---------------- */
  async function loadItems() {
    state.items = (await Store.allItems()).sort((a, b) => a.name.localeCompare(b.name));
    state.itemsById = new Map(state.items.map((i) => [i.id, i]));
    state.byBarcode = new Map(state.items.filter((i) => i.barcode).map((i) => [i.barcode, i]));
    // keep cart prices/names in sync with edits made to items
    state.cart = state.cart.map((l) => {
      const it = l.itemId && state.itemsById.get(l.itemId);
      return it ? Object.assign({}, l, { name: it.name, priceCents: it.priceCents, costCents: it.costCents || 0 }) : l;
    });
  }
  async function saveSettings() { await Store.saveSettings(state.settings); }

  /* ---------------- tabs ---------------- */
  function showTab(name) {
    state.tab = name;
    ['sell', 'inv', 'hist', 'more'].forEach((t) => { $('#view-' + t).hidden = t !== name; });
    $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    $('#checkoutBar').hidden = name !== 'sell';
    document.body.classList.toggle('has-checkout', name === 'sell');
    if (name === 'sell') renderSell();
    if (name === 'inv') renderInv();
    if (name === 'hist') renderHistory();
    if (name === 'more') renderMore();
    window.scrollTo(0, 0);
  }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  function renderHeader() {
    $('#storeName').textContent = state.settings.storeName || 'Store POS';
    document.title = (state.settings.storeName || 'Store POS');
  }
  function renderNet() {
    const on = navigator.onLine;
    const b = $('#netBadge');
    b.textContent = on ? 'Online' : 'Offline';
    b.classList.toggle('off', !on);
  }
  window.addEventListener('online', renderNet);
  window.addEventListener('offline', renderNet);

  /* =========================================================
     SELL
     ========================================================= */
  function stockOf(l) { const it = l.itemId && state.itemsById.get(l.itemId); return it ? it.stock : null; }

  function renderSell() {
    const cart = $('#cart');
    if (!state.cart.length) {
      cart.innerHTML = '<div class="empty">Cart is empty.<br>Scan an item with 📷 or search by name above.</div>';
    } else {
      cart.innerHTML = state.cart.map((l) => {
        const st = stockOf(l);
        const warn = st !== null && l.qty > st ? `<span class="warn">only ${st} in stock</span>` : '';
        return `<div class="line" data-key="${esc(l.key)}">
          <div class="l-main"><div class="l-name">${esc(l.name)}</div>
            <div class="l-sub">${money(l.priceCents)} each${l.custom ? ' · quick item' : ''} ${warn}</div></div>
          <div class="stepper"><button data-act="dec" aria-label="Decrease quantity">−</button>
            <button data-act="qty" class="qty" aria-label="Edit quantity">${l.qty}</button>
            <button data-act="inc" aria-label="Increase quantity">+</button></div>
          <div class="l-total">${money(l.priceCents * l.qty)}</div>
          <button class="icon" data-act="rm" aria-label="Remove">✕</button></div>`;
      }).join('');
    }
    $('#cartTotal').textContent = money(Core.cartTotal(state.cart));
    const u = Core.cartUnits(state.cart);
    $('#cartCount').textContent = u + (u === 1 ? ' item' : ' items');
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
    if (line && line.qty > item.stock) toast(`Only ${item.stock} of "${item.name}" in stock`);
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
      ? res.map((i) => `<button type="button" class="res" data-id="${esc(i.id)}"><span>${esc(i.name)}</span><span class="muted">${money(i.priceCents)} · ${i.stock} left</span></button>`).join('')
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
      <p>Barcode <strong>${esc(code)}</strong> isn't registered yet.</p>
      <div class="actions"><button class="btn" data-close>Cancel</button><span class="grow"></span>
      <button class="btn primary" id="addUnknown">Add this item</button></div></div>`);
    $('#addUnknown', dlg).onclick = () => itemForm(null, code, false);
  }

  function scanForSale() {
    const added = new Map();
    return Scanner.open({
      title: 'Scan items to sell', continuous: true,
      onCode: async (code, ctl) => {
        const it = state.byBarcode.get(code);
        if (!it) { ctl.close(); offerAddUnknown(code); return; }
        addToCart(it);
        added.set(it.id, (added.get(it.id) || 0) + 1);
        const line = state.cart.find((l) => l.itemId === it.id);
        ctl.setStatus(`✓ ${it.name} — qty ${line.qty} · Cart ${money(Core.cartTotal(state.cart))}`);
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
    else if (act === 'rm') state.cart = Core.cartSetQty(state.cart, key, 0);
    else if (act === 'qty') return qtyDialog(line);
    renderSell();
  });

  function qtyDialog(line) {
    openDialog(`<form class="sheet" id="qtyForm" novalidate><h2>${esc(line.name)}</h2>
      <label>Quantity <input name="qty" inputmode="numeric" value="${line.qty}" autocomplete="off"></label>
      <p class="error" id="qtyErr" role="alert"></p>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><span class="grow"></span><button class="btn primary">OK</button></div></form>`);
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
      <p class="muted">For something not in inventory (not stock-tracked).</p>
      <label>Description <input name="name" placeholder="e.g. Loose candy" autocomplete="off"></label>
      <div class="grid2"><label>Price <input name="price" inputmode="decimal" autocomplete="off"></label>
      <label>Qty <input name="qty" inputmode="numeric" value="1" autocomplete="off"></label></div>
      <p class="error" id="quickErr" role="alert"></p>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><span class="grow"></span><button class="btn primary">Add to cart</button></div></form>`);
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
    const total = Core.cartTotal(state.cart);
    const short = Core.stockShortfalls(state.cart, state.itemsById);
    const bills = [20, 50, 100, 200, 500, 1000, 2000].filter((b) => b * 100 >= total).slice(0, 4);
    openDialog(`<form class="sheet" id="payForm" novalidate>
      <h2>Charge</h2>
      <div class="bigtotal">${money(total)}</div>
      ${short.length ? `<p class="notice">Not enough stock recorded for: ${short.map((s) => esc(s.name) + ' (' + s.stock + ' left)').join(', ')}. You can still sell; stock will stop at 0.</p>` : ''}
      <label>Amount received <input name="paid" inputmode="decimal" autocomplete="off" placeholder="${(total / 100).toFixed(2)}"></label>
      <div class="chips"><button type="button" class="chip" data-amt="${total}">Exact</button>${bills.map((b) => `<button type="button" class="chip" data-amt="${b * 100}">${esc(state.settings.currency)}${b}</button>`).join('')}</div>
      <div class="changebox">Change <strong id="changeVal">${money(0)}</strong></div>
      <p class="error" id="payErr" role="alert"></p>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><span class="grow"></span><button class="btn primary big" id="payOk">Confirm sale</button></div></form>`);
    const f = $('#payForm', dlg), paidEl = f.elements.paid;
    const paidCents = () => { const v = paidEl.value.trim(); return v === '' ? total : Core.toCents(v); };
    const update = () => {
      const p = paidCents(), ok = Number.isFinite(p) && p >= total;
      $('#changeVal', dlg).textContent = ok ? money(p - total) : '—';
      $('#payErr', dlg).textContent = ok || paidEl.value.trim() === '' ? '' : (Number.isFinite(p) ? `Short by ${money(total - p)}` : 'Enter a valid amount.');
      $('#payOk', dlg).disabled = !ok;
    };
    paidEl.addEventListener('input', update);
    $$('.chip', dlg).forEach((c) => c.addEventListener('click', () => { paidEl.value = (Number(c.dataset.amt) / 100).toFixed(2); update(); }));
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
    openDialog(`<div class="sheet center"><div class="check-ok">✓</div><h2>Sale saved</h2>
      <p class="muted">Total ${money(sale.totalCents)} · Received ${money(sale.paidCents)}</p>
      <div class="changebox big">Change <strong>${money(sale.changeCents)}</strong></div>
      ${low.length ? `<p class="notice">Running low: ${low.map(esc).join(', ')}</p>` : ''}
      <div class="actions"><span class="grow"></span><button class="btn primary big" data-close>New sale</button><span class="grow"></span></div></div>`);
  }

  /* =========================================================
     INVENTORY
     ========================================================= */
  function renderInvIfVisible() { if (state.tab === 'inv') renderInv(); }

  function renderInv() {
    const q = $('#invSearch').value.trim();
    const lowOnly = $('#invLow').checked;
    let low = 0, out = 0, value = 0;
    state.items.forEach((i) => {
      if (i.stock === 0) out++; else if (i.stock <= i.lowStock) low++;
      value += (i.costCents || 0) * i.stock;
    });
    $('#invStats').innerHTML = [
      ['Items', state.items.length], ['Low', low, low ? 'warn' : ''], ['Out', out, out ? 'bad' : ''], ['Stock value (cost)', money(value)]
    ].map((s) => `<div class="stat ${s[2] || ''}"><span>${esc(s[0])}</span><strong>${esc(s[1])}</strong></div>`).join('');

    let list = state.items;
    if (q) {
      const words = q.toLowerCase().split(/\s+/);
      list = list.filter((i) => { const h = (i.name + ' ' + (i.barcode || '')).toLowerCase(); return words.every((w) => h.includes(w)); });
    }
    if (lowOnly) list = list.filter((i) => i.stock <= i.lowStock);
    const total = list.length;
    list = list.slice(0, 300);
    $('#invList').innerHTML = !state.items.length
      ? '<div class="empty">No items yet.<br>Tap <strong>📷 Scan</strong> to scan a barcode, or <strong>＋ Add</strong> to type one in.</div>'
      : !total ? '<div class="empty">No items match.</div>'
      : list.map((i) => {
        const cls = i.stock === 0 ? 'out' : i.stock <= i.lowStock ? 'low' : '';
        return `<div class="row" data-id="${esc(i.id)}"><div class="r-main"><div class="r-name">${esc(i.name)}</div>
          <div class="r-sub">${esc(i.barcode || 'no barcode')} · ${money(i.priceCents)}</div></div>
          <span class="stock ${cls}" title="In stock">${i.stock}</span>
          <button class="chip" data-act="restock">+ Stock</button></div>`;
      }).join('') + (total > 300 ? `<div class="empty small">Showing 300 of ${total}. Refine your search.</div>` : '');
  }
  $('#invSearch').addEventListener('input', debounce(renderInv, 80));
  $('#invLow').addEventListener('change', renderInv);
  $('#invList').addEventListener('click', (e) => {
    const row = e.target.closest('.row'); if (!row) return;
    const it = state.itemsById.get(row.dataset.id); if (!it) return;
    if (e.target.closest('[data-act="restock"]')) restockForm(it, false); else itemForm(it, '', false);
  });
  $('#invAdd').addEventListener('click', () => itemForm(null, '', false));
  $('#invScan').addEventListener('click', scanInventory);

  function scanInventory() {
    return Scanner.open({
      title: 'Scan item to add / restock', continuous: false,
      onCode: async (code, ctl) => {
        ctl.close();
        const it = state.byBarcode.get(code);
        if (it) restockForm(it, true); else itemForm(null, code, true);
      }
    });
  }

  function itemForm(item, prefillBarcode, fromScan) {
    const isNew = !item;
    const v = item || { name: '', barcode: prefillBarcode || '', priceCents: NaN, costCents: 0, stock: 0, lowStock: 5 };
    openDialog(`<form class="sheet" id="itemForm" novalidate autocomplete="off">
      <h2>${isNew ? 'Add item' : 'Edit item'}</h2>
      <label>Barcode <div class="inline"><input name="barcode" value="${esc(v.barcode || '')}" placeholder="Scan or type (optional)" inputmode="text">
        <button type="button" class="btn" id="scanInto">📷 Scan</button></div></label>
      <label>Name <input name="name" value="${esc(v.name)}" maxlength="80" placeholder="e.g. Rice 1kg"></label>
      <div class="grid2">
        <label>Selling price <input name="price" inputmode="decimal" value="${Number.isFinite(v.priceCents) ? (v.priceCents / 100).toFixed(2) : ''}"></label>
        <label>Cost price <input name="cost" inputmode="decimal" value="${v.costCents ? (v.costCents / 100).toFixed(2) : ''}" placeholder="optional"></label>
      </div>
      <div class="grid2">
        <label>Stock on hand <input name="stock" inputmode="numeric" value="${v.stock}"></label>
        <label>Low-stock alert at <input name="low" inputmode="numeric" value="${v.lowStock}"></label>
      </div>
      <p class="error" id="itemErr" role="alert"></p>
      <div class="actions">
        ${isNew ? '' : '<button type="button" class="btn danger" id="delItem">Delete</button>'}
        <span class="grow"></span><button type="button" class="btn" data-close>Cancel</button>
        <button class="btn primary" value="save">Save</button>
        ${fromScan && isNew ? '<button class="btn primary" value="next">Save &amp; scan next</button>' : ''}
      </div></form>`);
    const f = $('#itemForm', dlg), err = $('#itemErr', dlg), el = f.elements;
    if (isNew) (el.barcode.value ? el.name : el.barcode).focus();

    $('#scanInto', dlg).onclick = () => Scanner.open({
      title: 'Scan barcode', continuous: false,
      onCode: async (code, ctl) => {
        ctl.close(); el.barcode.value = code;
        const other = state.byBarcode.get(code);
        err.textContent = other && (!item || other.id !== item.id) ? `Already used by "${other.name}".` : '';
        el.name.focus();
      }
    });
    if (!isNew) $('#delItem', dlg).onclick = async () => {
      if (!confirm(`Delete "${item.name}"? Past sales keep their records.`)) return;
      await Store.deleteItem(item.id); await loadItems(); renderInv(); renderSell(); closeDialog(); toast('Item deleted');
    };

    let saving = false;
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (saving) return;
      const goNext = e.submitter && e.submitter.value === 'next';
      const barcode = Core.canonBarcode(el.barcode.value);
      const data = {
        name: el.name.value.trim(), priceCents: Core.toCents(el.price.value),
        costCents: el.cost.value.trim() ? Core.toCents(el.cost.value) : 0,
        stock: Core.toCount(el.stock.value), lowStock: Core.toCount(el.low.value)
      };
      const errs = Core.validateItem(data);
      if (!errs.length && barcode) {
        const other = state.byBarcode.get(barcode);
        if (other && (!item || other.id !== item.id)) errs.push(`That barcode is already used by "${other.name}".`);
      }
      if (errs.length) { err.textContent = errs[0]; return; }
      const now = Date.now();
      const rec = Object.assign({ id: item ? item.id : Core.uid() }, data, barcode ? { barcode } : {},
        { createdAt: item ? item.createdAt : now, updatedAt: now });
      saving = true;
      try { await Store.saveItem(rec); }
      catch (ex) { saving = false; err.textContent = ex.message || 'Could not save.'; return; }
      await loadItems(); renderInv(); renderSell(); closeDialog();
      toast(isNew ? `Added "${rec.name}"` : 'Item saved');
      if (goNext) scanInventory();
    };
  }

  function restockForm(item, fromScan) {
    openDialog(`<form class="sheet" id="stockForm" novalidate>
      <h2>Add stock</h2>
      <p><strong>${esc(item.name)}</strong><br><span class="muted">${esc(item.barcode || '')} · currently ${item.stock} in stock</span></p>
      <label>Quantity received <input name="qty" inputmode="numeric" value="1" autocomplete="off"></label>
      <p class="error" id="stockErr" role="alert"></p>
      <div class="actions"><button type="button" class="btn" id="editInstead">Edit item</button><span class="grow"></span>
        <button type="button" class="btn" data-close>Cancel</button>
        <button class="btn primary" value="save">Add</button>
        ${fromScan ? '<button class="btn primary" value="next">Add &amp; scan next</button>' : ''}</div></form>`);
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
     HISTORY
     ========================================================= */
  function rangeFrom(r) {
    const now = Date.now();
    return r === 'today' ? Core.dayStart(now) : r === 'week' ? Core.dayStart(now - 6 * DAY) : r === 'month' ? Core.dayStart(now - 29 * DAY) : 0;
  }
  async function renderHistory() {
    const from = rangeFrom(state.range);
    const sales = await Store.salesSince(from);
    const s = Core.summarize(sales, from, null);
    $('#histStats').innerHTML = [['Sales', s.count], ['Revenue', money(s.revenue)], ['Est. profit', money(s.profit)], ['Items sold', s.units]]
      .map((x) => `<div class="stat"><span>${esc(x[0])}</span><strong>${esc(x[1])}</strong></div>`).join('');
    const shown = sales.slice(0, 200);
    $('#histList').innerHTML = !sales.length ? '<div class="empty">No sales in this period.</div>'
      : shown.map((sl) => {
        const units = sl.lines.reduce((n, l) => n + l.qty, 0);
        return `<button class="row sale ${sl.voidedAt ? 'void' : ''}" data-id="${esc(sl.id)}"><div class="r-main"><div class="r-name">${esc(fmtDateTime(sl.ts))}</div>
          <div class="r-sub">${units} item${units === 1 ? '' : 's'}${sl.voidedAt ? ' · VOIDED' : ''}</div></div><strong>${money(sl.totalCents)}</strong></button>`;
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
    const sale = state.histSales && state.histSales.get(r.dataset.id); if (sale) saleDetail(sale);
  });
  function saleDetail(sale) {
    openDialog(`<div class="sheet"><h2>Sale ${sale.voidedAt ? '<span class="tag">VOIDED</span>' : ''}</h2>
      <p class="muted">${esc(fmtDateTime(sale.ts))}</p>
      <div class="detail">${sale.lines.map((l) => `<div class="drow"><span>${l.qty} × ${esc(l.name)}</span><span>${money(l.priceCents * l.qty)}</span></div>`).join('')}
        <div class="drow tot"><span>Total</span><span>${money(sale.totalCents)}</span></div>
        <div class="drow"><span>Received</span><span>${money(sale.paidCents)}</span></div>
        <div class="drow"><span>Change</span><span>${money(sale.changeCents)}</span></div></div>
      <div class="actions">${sale.voidedAt ? '' : '<button class="btn danger" id="voidBtn">Void sale</button>'}<span class="grow"></span><button class="btn" data-close>Close</button></div></div>`);
    const vb = $('#voidBtn', dlg);
    if (vb) vb.onclick = async () => {
      if (!confirm('Void this sale? Items will be returned to stock and it will be excluded from totals.')) return;
      await Store.voidSale(sale.id); await loadItems(); renderHistory(); renderInvIfVisible(); closeDialog(); toast('Sale voided, stock restored');
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
      ? `Last backup: ${fmtDateTime(last)}. Your data lives only on this device — back up regularly.`
      : 'No backup yet. Your data lives only on this device — download a backup regularly and keep it somewhere safe.';
    $('#verInfo').textContent = `Store POS v${APP_VERSION} · works fully offline`;
    $('#btnInstall').hidden = !state.installPrompt;
    let info = '';
    try {
      if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); info += `Using ${(e.usage / 1048576).toFixed(1)} MB. `; }
      if (navigator.storage && navigator.storage.persisted) { const p = await navigator.storage.persisted(); info += p ? 'Storage is protected from automatic cleanup.' : 'Storage may be cleared if the phone runs very low on space.'; $('#btnPersist').hidden = p; }
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
    const rows = [['Barcode', 'Name', 'Price', 'Cost', 'Stock', 'Low-stock alert']]
      .concat(state.items.map((i) => [i.barcode || '', i.name, (i.priceCents / 100).toFixed(2), ((i.costCents || 0) / 100).toFixed(2), i.stock, i.lowStock]));
    download(`inventory-${isoDate(Date.now())}.csv`, '﻿' + Core.toCSV(rows), 'text/csv');
  });
  $('#btnCsvSales').addEventListener('click', async () => {
    const sales = (await Store.salesSince(0)).reverse();
    const rows = [['Date', 'Time', 'Sale ID', 'Item', 'Barcode', 'Qty', 'Unit price', 'Line total', 'Status']];
    sales.forEach((s) => {
      const d = new Date(s.ts);
      s.lines.forEach((l) => rows.push([isoDate(s.ts), d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), s.id, l.name, l.barcode || '', l.qty,
        (l.priceCents / 100).toFixed(2), ((l.priceCents * l.qty) / 100).toFixed(2), s.voidedAt ? 'VOIDED' : 'OK']));
    });
    download(`sales-${isoDate(Date.now())}.csv`, '﻿' + Core.toCSV(rows), 'text/csv');
  });
  $('#btnPersist').addEventListener('click', async () => {
    try { const ok = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; toast(ok ? 'Storage protected' : 'The browser declined. Installing the app to your home screen helps.'); } catch (e) { /* ignore */ }
    renderMore();
  });
  $('#btnErase').addEventListener('click', async () => {
    if (!confirm('Erase ALL items and sales on this device? This cannot be undone.')) return;
    const t = prompt('Type ERASE to confirm. (Download a backup first if unsure.)');
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
      $('#app').innerHTML = `<div class="empty">Storage is unavailable: ${esc(err.message || err)}<br>Try a normal (non-private) browser window.</div>`;
      return;
    }
    renderHeader();
    showTab('sell');
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); // ask quietly for durable storage
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  init();
})();
