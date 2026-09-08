/** MAIN-world helper: report __FSE_LAST_MP__ to the content script. */
(() => {
  const id = document.currentScript && document.currentScript.dataset.fseId;
  window.postMessage(
    {
      source: 'figma-sites-exporter',
      type: 'PAGE_MP',
      id,
      url: window.__FSE_LAST_MP__ || null,
    },
    '*',
  );
})();
