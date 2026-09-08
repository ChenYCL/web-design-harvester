/**
 * Offscreen document: holds Blob object URLs for large ZIP downloads.
 * SW cannot createObjectURL; this page can.
 */
const objectUrls = new Set();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'OFFSCREEN_DOWNLOAD_ZIP') return;

  (async () => {
    try {
      const bytes = Uint8Array.from(atob(msg.base64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      objectUrls.add(url);
      const downloadId = await chrome.downloads.download({
        url,
        filename: msg.filename || 'figma-export.zip',
        saveAs: !!msg.saveAs,
      });
      // Revoke later — download needs the URL briefly
      setTimeout(() => {
        URL.revokeObjectURL(url);
        objectUrls.delete(url);
      }, 120000);
      sendResponse({ ok: true, downloadId });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});
