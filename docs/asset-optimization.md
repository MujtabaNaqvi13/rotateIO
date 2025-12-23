# Asset optimization recommendations ✅

This document lists practical steps to optimize assets for web delivery.

1) Image formats & sizes
- Convert large PNGs to WebP (lossy or lossless) or use multiple quality levels for streaming.
- Generate small preview/thumbnail versions for initial screens and lazy-load higher-resolution versions.
- Use texture atlases / sprite sheets to reduce HTTP requests.

2) Audio
- Use Opus in Ogg containers (.ogg) or AAC depending on target browsers.
- Export at appropriate bitrate (e.g., 64–128kbps for ambient music, 32kbps for SFX when acceptable).
- Consider multiple versions for progressive loading.

3) Compression & server config
- Enable Brotli (recommended) and gzip fallback on the hosting server; ensure proper `Content-Encoding` headers.
- Pre-compress large assets in the build pipeline and serve with correct headers during deployment.

4) Code-splitting & bundles
- Split large modules (map streaming, editor tools) into separate bundles and `import()` them on demand.
- Minify and tree-shake using a bundler (esbuild/rollup/webpack/Vite).

5) Streaming & progressive loading
- Stream large map chunks and only load adjacent chunks as players move around.
- Use `AssetLoader.loadAssetByName()` for on-demand chunk loads (already implemented in client).

Implementation note: the client now implements a simple streaming loader that divides the map into 3 columns by default and loads the current chunk plus adjacent chunks automatically (`script.js` methods `loadMapChunksAroundPlayer`, `loadMapChunk`, `unloadChunk`). Tune `chunkSize` and `chunkLoadRadius` in the `RotateIOGame` constructor to adjust behavior.

6) Caching
- Use Service Worker and Cache API (already implemented) for essentials and cache-on-fetch strategy for lazy assets.
- Consider IndexedDB for very large binary assets if needed.

7) Web Workers
- Offload heavy parsing (map chunk decoding, audio decoding) to Web Workers. The project already uses `assets/assetLoaderWorker.js` to fetch binary data off the main thread.

Implementing these steps during your CI/build and deployment will significantly reduce initial load times and improve returning-player experience.