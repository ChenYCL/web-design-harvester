/**
 * MAIN-world WYSIWYG capture for Figma Sites preview.
 * Produces HTML + CSS text + list of absolute asset URLs to rewrite.
 * Loaded via <script src=chrome-extension://.../lib/capture-site.js>
 */
(() => {
  if (window.__FSE_CAPTURE_SITE__) return;
  window.__FSE_CAPTURE_SITE__ = true;

  const ABS = /url\(["']?([^"')]+)["']?\)/gi;

  function isShell() {
    const t = (document.body?.innerText || '').slice(0, 100);
    return /messagePort|allowedOrigins/.test(t) && document.querySelectorAll('body *').length < 20;
  }

  function collectStyles() {
    const chunks = [];
    for (const sheet of Array.from(document.styleSheets || [])) {
      try {
        const rules = sheet.cssRules || sheet.rules;
        if (!rules) continue;
        for (const rule of Array.from(rules)) chunks.push(rule.cssText);
      } catch {
        // cross-origin stylesheet — try link href as asset
        if (sheet.href) chunks.push(`/* external: ${sheet.href} */`);
      }
    }
    for (const st of document.querySelectorAll('style')) {
      chunks.push(st.textContent || '');
    }
    return chunks.join('\n');
  }

  function collectAssetUrls() {
    const urls = new Set();
    const add = (u) => {
      if (!u) return;
      try {
        const abs = new URL(u, location.href).href;
        if (/^(https?:|data:|blob:)/i.test(abs)) urls.add(abs);
      } catch { /* ignore */ }
    };

    for (const el of document.querySelectorAll('img,video,source,audio,use')) {
      add(el.currentSrc || el.src || el.getAttribute('href') || el.getAttribute('xlink:href'));
      if (el.srcset) {
        for (const part of el.srcset.split(',')) add(part.trim().split(/\s+/)[0]);
      }
      if (el.poster) add(el.poster);
    }
    for (const el of document.querySelectorAll('[style]')) {
      const s = el.getAttribute('style') || '';
      let m;
      ABS.lastIndex = 0;
      while ((m = ABS.exec(s))) add(m[1]);
    }
    // computed backgrounds for visible media-ish nodes (sample cap)
    const all = document.querySelectorAll('body *');
    const lim = Math.min(all.length, 2500);
    for (let i = 0; i < lim; i++) {
      const cs = getComputedStyle(all[i]);
      const bg = cs.backgroundImage;
      if (bg && bg !== 'none') {
        let m;
        ABS.lastIndex = 0;
        while ((m = ABS.exec(bg))) add(m[1]);
      }
    }
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) add(link.href);
    try {
      for (const e of performance.getEntriesByType('resource')) {
        const n = e.name || '';
        if (/\.(png|jpe?g|gif|webp|svg|mp4|webm|mov|woff2?)(\?|$)/i.test(n)) add(n);
        if (/s3-alpha.*figma\.com\/img\//i.test(n)) add(n);
      }
    } catch { /* ignore */ }
    return [...urls].filter((u) => !u.startsWith('data:') && !u.startsWith('blob:'));
  }

  function rewriteUrl(cssOrHtml, mapping) {
    let out = cssOrHtml;
    for (const [from, to] of Object.entries(mapping)) {
      out = out.split(from).join(to);
      try {
        const enc = encodeURI(from);
        if (enc !== from) out = out.split(enc).join(to);
      } catch { /* ignore */ }
    }
    return out;
  }

  function buildMarkup(assetMap) {
    const clone = document.documentElement.cloneNode(true);
    // Drop scripts that won't work offline (keep structure)
    clone.querySelectorAll('script').forEach((s) => s.remove());
    // Keep noscript?
    const mapAttr = (el, attr) => {
      const v = el.getAttribute(attr);
      if (!v) return;
      if (assetMap[v]) el.setAttribute(attr, assetMap[v]);
      else {
        try {
          const abs = new URL(v, location.href).href;
          if (assetMap[abs]) el.setAttribute(attr, assetMap[abs]);
        } catch { /* ignore */ }
      }
    };
    clone.querySelectorAll('img,video,source,audio').forEach((el) => {
      mapAttr(el, 'src');
      mapAttr(el, 'poster');
      if (el.getAttribute('srcset')) {
        // simplify srcset to primary rewritten src
        const src = el.getAttribute('src');
        if (src) el.removeAttribute('srcset');
      }
    });
    // Inline a base stylesheet link
    const head = clone.querySelector('head') || clone;
    head.querySelectorAll('link[rel="stylesheet"]').forEach((l) => l.remove());
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'styles.css';
    head.appendChild(link);
    // Minimal interaction helper
    const inter = document.createElement('script');
    inter.src = 'interactions.js';
    clone.querySelector('body')?.appendChild(inter);

    return '<!doctype html>\n' + clone.outerHTML;
  }

  /**
   * @returns {{ok:boolean, error?:string, title?:string, html?:string, css?:string, assets?:Array<{url:string, path:string}>}}
   */
  window.__FSE_CAPTURE__ = function captureSite() {
    if (isShell()) return { ok: false, error: 'preview still shell' };
    const urls = collectAssetUrls();
    const assets = urls.map((url, i) => {
      const extMatch = url.match(/\.(png|jpe?g|gif|webp|svg|mp4|webm|mov|woff2?|css)(\?|$)/i);
      const ext = extMatch ? extMatch[1].toLowerCase().replace('jpeg', 'jpg') : 'bin';
      const path = `assets/${String(i).padStart(4, '0')}.${ext}`;
      return { url, path };
    });
    const assetMap = Object.fromEntries(assets.map((a) => [a.url, a.path]));
    let css = collectStyles();
    css = rewriteUrl(css, assetMap);
    // Also append a small reset so absolute layouts hold
    css =
      `/* fse capture */\nhtml,body{margin:0;padding:0;}\n` +
      css +
      `\n/* end fse */\n`;
    const html = rewriteUrl(buildMarkup(assetMap), assetMap);
    return {
      ok: true,
      title: document.title || 'figma-site',
      url: location.href,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scrollHeight: Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0),
      html,
      css,
      assets,
      assetCount: assets.length,
      htmlBytes: html.length,
      cssBytes: css.length,
    };
  };
})();
