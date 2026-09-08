/** MAIN world: invoke __FSE_CAPTURE__ and post result to content script. */
(() => {
  let result;
  try {
    result = window.__FSE_CAPTURE__ ? window.__FSE_CAPTURE__() : { ok: false, error: 'capture fn missing' };
  } catch (e) {
    result = { ok: false, error: String(e && e.message ? e.message : e) };
  }
  window.postMessage({ source: 'figma-sites-exporter', type: 'CAPTURE_RESULT', result }, '*');
})();
