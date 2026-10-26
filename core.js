/* core.js — pure business logic (no DOM, no storage). Unit-tested in tests/core.test.js.
 * All money is handled as integer centavos to avoid floating-point errors. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** "1,234.50" | "₱45" | "45,5" -> integer cents, or NaN if not a valid amount. */
  function toCents(input) {
    if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? Math.round(input * 100) : NaN;
    let s = String(input == null ? '' : input).replace(/[^\d.,]/g, '');
    if (!s) return NaN;
    if (s.includes('.')) s = s.replace(/,/g, '');
    else s = s.replace(/,(?=\d{1,2}$)/, '.').replace(/,/g, '');
    const n = Number(s + 'e2'); // decimal-exact scaling: "12.345e2" -> 1234.5
    return Number.isFinite(n) ? Math.round(n) : NaN;
  }

  function formatMoney(cents, symbol) {
    if (!Number.isFinite(cents)) return '—';
    const sym = symbol == null ? '₱' : symbol;
    const abs = Math.abs(Math.round(cents));
    const s = (abs / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (cents < 0 ? '-' : '') + sym + s;
  }

  /** Whole non-negative number from text. Empty -> 0. Invalid -> NaN. */
  function toCount(input) {
    const t = String(input == null ? '' : input).trim();
    const n = Number(t === '' ? '0' : t);
    return Number.isInteger(n) && n >= 0 ? n : NaN;
  }

  /** Normalise a scanned/typed barcode. UPC-A (12 digits) is stored as EAN-13 with a leading 0,
   *  because different scanners report the same product either way. */
  function canonBarcode(raw) {
    let s = String(raw == null ? '' : raw).replace(/[\u0000-\u001F\u007F\s]/g, '');
    if (/^\d{12}$/.test(s)) s = '0' + s;
    return s;
  }

  function uid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /** f = { name, priceCents, costCents, stock, lowStock } -> array of error strings. */
  function validateItem(f) {
    const errors = [];
    if (!String(f.name || '').trim()) errors.push('Enter an item name.');
    if (!Number.isFinite(f.priceCents) || f.priceCents <= 0) errors.push('Enter a selling price greater than 0.');
    if (!Number.isFinite(f.costCents) || f.costCents < 0) errors.push('Cost price is not a valid amount.');
    if (!Number.isInteger(f.stock) || f.stock < 0) errors.push('Stock must be a whole number (0 or more).');
    if (!Number.isInteger(f.lowStock) || f.lowStock < 0) errors.push('Low-stock alert must be a whole number (0 or more).');
    return errors;
  }

  /* ---------- cart (immutable helpers) ---------- */
  function cartAdd(cart, item, qty) {
    qty = qty || 1;
    const i = cart.findIndex(function (l) { return l.itemId === item.id; });
    if (i >= 0) return cart.map(function (l, k) { return k === i ? Object.assign({}, l, { qty: l.qty + qty }) : l; });
    return cart.concat([{
      key: item.id, itemId: item.id, barcode: item.barcode || '', name: item.name,
      priceCents: item.priceCents, costCents: item.costCents || 0, qty: qty, custom: false
    }]);
  }
  function cartAddCustom(cart, name, priceCents, qty) {
    return cart.concat([{
      key: uid(), itemId: null, barcode: '', name: String(name || '').trim() || 'Quick item',
      priceCents: priceCents, costCents: 0, qty: qty || 1, custom: true
    }]);
  }
  function cartSetQty(cart, key, qty) {
    if (!(qty > 0)) return cart.filter(function (l) { return l.key !== key; });
    return cart.map(function (l) { return l.key === key ? Object.assign({}, l, { qty: qty }) : l; });
  }
  function cartTotal(cart) { return cart.reduce(function (s, l) { return s + l.priceCents * l.qty; }, 0); }
  function cartUnits(cart) { return cart.reduce(function (s, l) { return s + l.qty; }, 0); }

  /** Cart lines asking for more than is on hand (only for tracked, still-existing items). */
  function stockShortfalls(cart, itemsById) {
    const out = [];
    cart.forEach(function (l) {
      const it = l.itemId && itemsById.get(l.itemId);
      if (it && l.qty > it.stock) out.push({ name: l.name, qty: l.qty, stock: it.stock });
    });
    return out;
  }

  function buildSale(cart, opts) {
    opts = opts || {};
    const totalCents = cartTotal(cart);
    const paidCents = Number.isFinite(opts.paidCents) ? opts.paidCents : totalCents;
    return {
      id: opts.id || uid(),
      ts: opts.ts || Date.now(),
      lines: cart.map(function (l) {
        return { itemId: l.itemId, name: l.name, barcode: l.barcode, priceCents: l.priceCents,
                 costCents: l.costCents, qty: l.qty, stockDeducted: 0 };
      }),
      totalCents: totalCents,
      paidCents: paidCents,
      changeCents: Math.max(0, paidCents - totalCents)
    };
  }

  /** Stock never goes below zero; we record exactly what was deducted so a void restores exactly that. */
  function deductStock(stock, qty) {
    const deducted = Math.min(Math.max(stock, 0), qty);
    return { newStock: stock - deducted, deducted: deducted };
  }

  /* ---------- reporting ---------- */
  function summarize(sales, fromTs, toTs) {
    let count = 0, revenue = 0, cost = 0, units = 0;
    sales.forEach(function (s) {
      if (s.voidedAt) return;
      if (fromTs != null && s.ts < fromTs) return;
      if (toTs != null && s.ts >= toTs) return;
      count++; revenue += s.totalCents;
      s.lines.forEach(function (l) { cost += (l.costCents || 0) * l.qty; units += l.qty; });
    });
    return { count: count, revenue: revenue, cost: cost, profit: revenue - cost, units: units };
  }

  function dayStart(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }

  /* ---------- CSV ---------- */
  function csvCell(v) {
    let s = v == null ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // block spreadsheet formula injection
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(rows) { return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n'); }

  return {
    toCents: toCents, formatMoney: formatMoney, toCount: toCount, canonBarcode: canonBarcode, uid: uid,
    validateItem: validateItem, cartAdd: cartAdd, cartAddCustom: cartAddCustom, cartSetQty: cartSetQty,
    cartTotal: cartTotal, cartUnits: cartUnits, stockShortfalls: stockShortfalls, buildSale: buildSale,
    deductStock: deductStock, summarize: summarize, dayStart: dayStart, toCSV: toCSV
  };
});
