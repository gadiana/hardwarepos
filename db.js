/* db.js — IndexedDB persistence. Everything lives on the device; nothing is sent anywhere.
 * Stores: items (unique barcode index), sales (ts index), meta (settings). */
(function () {
  'use strict';
  var DB_NAME = 'grocery-pos';
  var DB_VERSION = 1;
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('This browser does not support offline storage.'));
      var r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = function () {
        var d = r.result;
        var items = d.createObjectStore('items', { keyPath: 'id' });
        items.createIndex('barcode', 'barcode', { unique: true }); // items without a barcode are simply not indexed
        var sales = d.createObjectStore('sales', { keyPath: 'id' });
        sales.createIndex('ts', 'ts');
        d.createObjectStore('meta', { keyPath: 'key' });
      };
      r.onsuccess = function () {
        var db = r.result;
        db.onversionchange = function () { db.close(); };
        resolve(db);
      };
      r.onerror = function () { reject(r.error); };
      r.onblocked = function () { reject(new Error('Close other tabs of this app and reload.')); };
    });
    return dbPromise;
  }

  function reqP(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function txDone(tx) {
    var p = new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('Transaction aborted')); };
    });
    p.catch(function () {}); // avoid unhandled-rejection noise; callers await it explicitly
    return p;
  }
  async function begin(stores, mode) {
    var db = await open();
    var tx = db.transaction(stores, mode || 'readonly');
    return { tx: tx, done: txDone(tx) };
  }

  var Store = {
    open: open,

    async getSettings() {
      var t = await begin('meta');
      var row = await reqP(t.tx.objectStore('meta').get('settings'));
      return row ? row.value : null;
    },
    async saveSettings(value) {
      var t = await begin('meta', 'readwrite');
      t.tx.objectStore('meta').put({ key: 'settings', value: value });
      await t.done;
    },

    async allItems() {
      var t = await begin('items');
      return reqP(t.tx.objectStore('items').getAll());
    },
    async itemByBarcode(code) {
      if (!code) return null;
      var t = await begin('items');
      return (await reqP(t.tx.objectStore('items').index('barcode').get(code))) || null;
    },
    async saveItem(item) {
      if (!item.barcode) delete item.barcode;
      var t = await begin('items', 'readwrite');
      try {
        await reqP(t.tx.objectStore('items').put(item));
        await t.done;
      } catch (e) {
        if (e && e.name === 'ConstraintError') {
          var err = new Error('Another item already uses this barcode.');
          err.code = 'DUP_BARCODE';
          throw err;
        }
        throw e;
      }
    },
    async deleteItem(id) {
      var t = await begin('items', 'readwrite');
      t.tx.objectStore('items').delete(id);
      await t.done;
    },
    /** Add (or subtract, with a negative delta) stock atomically. */
    async adjustStock(id, delta) {
      var t = await begin('items', 'readwrite');
      var st = t.tx.objectStore('items');
      var it = await reqP(st.get(id));
      if (!it) throw new Error('Item no longer exists.');
      it.stock = Math.max(0, it.stock + delta);
      it.updatedAt = Date.now();
      st.put(it);
      await t.done;
      return it;
    },

    /** Saves the sale and deducts stock in ONE transaction: either both happen or neither. */
    async recordSale(sale) {
      var t = await begin(['items', 'sales'], 'readwrite');
      var items = t.tx.objectStore('items');
      for (var i = 0; i < sale.lines.length; i++) {
        var line = sale.lines[i];
        line.stockDeducted = 0;
        if (!line.itemId) continue;
        var it = await reqP(items.get(line.itemId));
        if (!it) continue; // item was deleted meanwhile; sale still recorded from its snapshot
        var r = Core.deductStock(it.stock, line.qty);
        line.stockDeducted = r.deducted;
        it.stock = r.newStock;
        it.updatedAt = sale.ts;
        items.put(it);
      }
      t.tx.objectStore('sales').put(sale);
      await t.done;
      return sale;
    },
    async voidSale(id) {
      var t = await begin(['items', 'sales'], 'readwrite');
      var sales = t.tx.objectStore('sales');
      var items = t.tx.objectStore('items');
      var sale = await reqP(sales.get(id));
      if (!sale || sale.voidedAt) return sale || null;
      for (var i = 0; i < sale.lines.length; i++) {
        var line = sale.lines[i];
        if (!line.itemId || !line.stockDeducted) continue;
        var it = await reqP(items.get(line.itemId));
        if (!it) continue;
        it.stock += line.stockDeducted;
        it.updatedAt = Date.now();
        items.put(it);
      }
      sale.voidedAt = Date.now();
      sales.put(sale);
      await t.done;
      return sale;
    },
    async salesSince(ts) {
      var t = await begin('sales');
      var rows = await reqP(t.tx.objectStore('sales').index('ts').getAll(IDBKeyRange.lowerBound(ts || 0)));
      return rows.sort(function (a, b) { return b.ts - a.ts; });
    },

    async exportAll() {
      var t = await begin(['items', 'sales', 'meta']);
      var out = {
        app: 'grocery-pos', version: 1, exportedAt: Date.now(),
        items: await reqP(t.tx.objectStore('items').getAll()),
        sales: await reqP(t.tx.objectStore('sales').getAll()),
        settings: ((await reqP(t.tx.objectStore('meta').get('settings'))) || {}).value || null
      };
      return out;
    },
    async importAll(data) {
      if (!data || data.app !== 'grocery-pos' || !Array.isArray(data.items) || !Array.isArray(data.sales)) {
        throw new Error('This file is not a Store POS backup.');
      }
      var t = await begin(['items', 'sales', 'meta'], 'readwrite');
      var items = t.tx.objectStore('items'), sales = t.tx.objectStore('sales'), meta = t.tx.objectStore('meta');
      items.clear(); sales.clear();
      data.items.forEach(function (x) { if (!x.barcode) delete x.barcode; items.put(x); });
      data.sales.forEach(function (x) { sales.put(x); });
      if (data.settings) meta.put({ key: 'settings', value: data.settings });
      await t.done;
    },
    async clearAll() {
      var t = await begin(['items', 'sales', 'meta'], 'readwrite');
      t.tx.objectStore('items').clear();
      t.tx.objectStore('sales').clear();
      t.tx.objectStore('meta').clear();
      await t.done;
    }
  };

  window.Store = Store;
})();
