// Simple asset loader with essential preloading + lazy background loading
// Uses Cache API and optional Web Worker (assets/assetLoaderWorker.js) for background fetch

const AssetLoader = (function(){
  const manifestUrl = '/assets/manifest.json';
  const cacheName = 'rotateio-assets-v1';
  let manifest = null;
  let assets = {}; // name -> { type, data }
  let worker = null;

  async function loadManifest() {
    if (manifest) return manifest;
    const res = await fetch(manifestUrl, { cache: 'no-cache' });
    manifest = await res.json();
    return manifest;
  }

  // Fast helper to check Cache storage
  async function checkCache(url) {
    if (!('caches' in window)) return null;
    const c = await caches.open(cacheName);
    const r = await c.match(url);
    if (!r) return null;
    // clone so we can use it multiple times
    return r.clone();
  }

  async function cachePut(url, response) {
    if (!('caches' in window)) return;
    const c = await caches.open(cacheName);
    c.put(url, response.clone());
  }

  function setupWorker() {
    if (!('Worker' in window)) return null;
    try {
      const w = new Worker('assets/assetLoaderWorker.js');
      return w;
    } catch (e) { return null; }
  }

  // Load an asset with progress callback (progress called with (loaded, total) when available)
  async function loadAssetEntry(entry, onProgress) {
    const { name, url, type } = entry;
    // check already loaded
    if (assets[name]) return assets[name];

    // check cache
    const cached = await checkCache(url);
    if (cached) {
      if (type === 'image') {
        const blob = await cached.blob();
        const bitmap = await createImageBitmap(blob);
        assets[name] = { type, data: bitmap };
        return assets[name];
      } else if (type === 'json') {
        const j = await cached.json();
        assets[name] = { type, data: j };
        return assets[name];
      } else if (type === 'audio') {
        const blob = await cached.blob();
        assets[name] = { type, data: blob };
        return assets[name];
      }
    }

    // try worker fetch for images and binary types
    if (!worker) worker = setupWorker();
    if (worker && (type === 'image' || type === 'audio' || type === 'json')) {
      return new Promise((resolve, reject) => {
        const onmsg = async (e) => {
          const msg = e.data;
          if (msg.name !== name) return;
          worker.removeEventListener('message', onmsg);
          if (msg.error) return reject(new Error(msg.error));
          try {
            if (type === 'image') {
              const blob = new Blob([msg.buffer]);
              cachePut(url, new Response(blob));
              const bitmap = await createImageBitmap(blob);
              assets[name] = { type, data: bitmap };
              resolve(assets[name]);
            } else if (type === 'json') {
              const text = new TextDecoder().decode(msg.buffer);
              const json = JSON.parse(text);
              cachePut(url, new Response(JSON.stringify(json)));
              assets[name] = { type, data: json };
              resolve(assets[name]);
            } else if (type === 'audio') {
              const blob = new Blob([msg.buffer]);
              cachePut(url, new Response(blob));
              assets[name] = { type, data: blob };
              resolve(assets[name]);
            }
          } catch (err) { reject(err); }
        };
        worker.addEventListener('message', onmsg);
        worker.postMessage({ cmd: 'fetch', url, name, type });
      });
    }

    // Fallback: fetch on main thread
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Load failed: '+url);
    await cachePut(url, resp.clone());
    if (type === 'image') {
      const blob = await resp.blob();
      const bitmap = await createImageBitmap(blob);
      assets[name] = { type, data: bitmap };
      return assets[name];
    } else if (type === 'json') {
      const j = await resp.json();
      assets[name] = { type, data: j };
      return assets[name];
    } else if (type === 'audio') {
      const blob = await resp.blob();
      assets[name] = { type, data: blob };
      return assets[name];
    }
    return null;
  }

  async function preloadEssential(onProgress) {
    const m = await loadManifest();
    const essential = m.assets.filter(a => a.priority === 'essential');
    let loaded = 0;
    const total = essential.length;
    for (const e of essential) {
      await loadAssetEntry(e);
      loaded++;
      if (onProgress) onProgress(loaded, total);
    }
    return true;
  }

  async function loadRemaining(onProgress) {
    const m = await loadManifest();
    const lazy = m.assets.filter(a => a.priority !== 'essential');
    let loaded = 0; const total = lazy.length;
    // run loads in parallel but report progress as each finishes; resolve when all settled
    const promises = lazy.map(e => loadAssetEntry(e).then(() => {
      loaded++; if (onProgress) onProgress(loaded, total);
    }).catch(err => { loaded++; if (onProgress) onProgress(loaded, total); console.warn('Lazy load failed', e.name, err); }));
    await Promise.all(promises);
    return true;
  }

  function getAsset(name) { return assets[name] ? assets[name].data : null; }

  // Load an individual asset by name (useful for on-demand map chunk streaming)
  async function loadAssetByName(name) {
    const m = await loadManifest();
    const entry = m.assets.find(a => a.name === name || a.url.endsWith(name));
    if (!entry) throw new Error('Asset not found: '+name);
    const res = await loadAssetEntry(entry);
    return res ? res.data : null;
  }

  // service worker registration
  async function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.register('/service-worker.js');
        console.log('Service Worker registered', reg.scope);
      } catch (err) { console.warn('SW reg failed', err); }
    }
  }

  return { preloadEssential, loadRemaining, loadAssetByName, getAsset, registerServiceWorker };
})();

window.AssetLoader = AssetLoader;
