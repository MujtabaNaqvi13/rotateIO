self.addEventListener('message', async (e) => {
  const msg = e.data;
  try {
    if (msg.cmd === 'fetch') {
      const res = await fetch(msg.url);
      const buffer = await res.arrayBuffer();
      // Transfer arrayBuffer back to main thread for decoding/creating bitmaps
      self.postMessage({ name: msg.name, type: msg.type, buffer }, [buffer]);
    }
  } catch (err) {
    self.postMessage({ name: msg.name, type: msg.type, error: err && err.message });
  }
});
