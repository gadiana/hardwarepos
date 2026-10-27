# Store POS — offline point-of-sale for a small grocery

A single-folder web app (PWA). No server, no database service, no monthly cost. All data is stored **on the phone** and the app works with **no internet** after the first load.

## What it does
- **Sell**: scan a barcode with the camera (📷), type/scan with a USB or Bluetooth scanner, or search by name. Cart, quantity edit, quick (non-inventory) item, cash received + change, stock is deducted automatically.
- **Inventory**: scan to add a new item or restock an existing one ("Save & scan next" for receiving deliveries), or add/edit manually. Cost price, low-stock alerts, stock value.
- **Multi-buy deals**: set a deal on any item, e.g. candy at 2.00 each **or 3 for 5.00**. The cart prices it automatically: 1 = 2.00, 2 = 4.00, 3 = 5.00, 4 = 7.00, 5 = 9.00, 6 = 10.00. Leave the deal blank for a plain price (2.00 per candy). A deal must be cheaper than buying the same number one by one.
- **Sales (history)**: today / 7 days / 30 days / all, revenue and estimated profit, void a sale (stock is restored).
- **More**: store name, currency symbol, **backup / restore (JSON)**, CSV export, protect storage.

## IMPORTANT things to know
1. **Data lives only on the device/browser you use.** Two phones = two separate databases (no sync). Download a backup from *More → Download backup* regularly (the app reminds you after 7 days). Clearing the browser's site data, or uninstalling, deletes it.
2. **Camera scanning** uses the browser's built-in `BarcodeDetector`: works in **Chrome, Edge and Samsung Internet on Android** (and desktop Chrome on macOS/ChromeOS). Needs HTTPS (any host below provides it). Open the scanner once while online after installing.
   - Not supported by iPhone Safari or Firefox. There you can still use a Bluetooth/USB scanner, type the barcode, or add the optional fallback (below).
3. Quantities are whole numbers (no decimals such as 0.5 kg).
4. UPC-A (12 digits) and EAN-13 (13 digits with a leading 0) are treated as the same product.

## Optional: camera fallback for iPhone / Firefox
Download `html5-qrcode.min.js` (from the npm package `html5-qrcode`, e.g. `https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js`) and save it as `lib/html5-qrcode.min.js`. The app loads it automatically only when the browser has no built-in detector. Then bump `VERSION` in `sw.js` and redeploy.

## Deploy for $0 (pick ONE)
You need the **contents of this folder** at the root of the site (`index.html` must be at the top level).

### Option A — Cloudflare Pages (free, unlimited bandwidth)
1. Create a free account at https://dash.cloudflare.com.
2. Go to **Workers & Pages → Create → Pages → Upload assets (Direct Upload)**. (Menu names change occasionally; if you only see Workers, use Option B.)
3. Name the project, e.g. `my-store-pos`.
4. Drag in this unzipped folder (or the zip) and click **Deploy**.
5. Your app is live at `https://my-store-pos.pages.dev`.

### Option B — GitHub Pages (free; repository must be public — no data is ever in it)
1. Create a free account at https://github.com, then **New repository** (name `store-pos`, Public).
2. Click **uploading an existing file**, drag **all files and the `icons` and `lib` folders** from the unzipped folder, then **Commit changes**. (GitHub's web upload does not unzip a .zip for you.)
3. **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main`, folder `/ (root)` → Save.**
4. After 1–2 minutes it is live at `https://YOUR-USERNAME.github.io/store-pos/`.

### Option C — Netlify Drop
Drag the unzipped folder onto https://app.netlify.com/drop and sign up to keep the site. Free tier has monthly limits that are far above what one shop needs.

## Install on the phone
1. On the shop phone open the URL in **Chrome**, with internet on. Wait for it to load completely.
2. Menu **⋮ → Install app** (or *Add to Home screen*). Open it from the home-screen icon.
3. Tap **Sell → 📷 Scan** once and **Allow** the camera.
4. Test: switch on airplane mode, open the app, add an item and make a sale. It all still works.
5. *More → Protect my data*, and do your first backup.

## Updating a phone that already has the app
1. Upload the new files to the same GitHub repository (or Cloudflare project) and replace the old ones, including the `icons` folder.
2. On the phone, open the app **with internet on**, close it fully, then open it again. The second open shows the new version (*More* shows the version number at the bottom).
3. Your items and sales are kept. Back up first if you want to be safe.
4. The home-screen icon changes only after Chrome refreshes the installed app, which can take a day. Removing and reinstalling the app updates it at once, but export a backup first, because uninstalling deletes the data.

## Updating after you change files
Edit `VERSION` in `sw.js` (e.g. `v1.0.1`) before redeploying, otherwise phones keep the old cached copy. Re-open the app twice (online) to pick up the update.

## Files
`index.html` UI · `app.js` screens · `core.js` pricing/stock/report logic (unit-tested) · `db.js` IndexedDB storage · `scanner.js` camera scanning · `sw.js` offline cache · `manifest.webmanifest` + `icons/` install info · `_headers` cache rules for Cloudflare/Netlify.
