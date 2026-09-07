(() => {
  const d = document.querySelector("#canvas-av-dock");
  const glyphs = [...document.querySelectorAll('[aria-label*="viewing"],[title*="viewing"]')].map((e) => {
    let n = e, href = null, text = null;
    for (let i = 0; i < 12 && n; i++) {
      const a = n.querySelector ? n.querySelector('a[href*="/threads/"]') : null;
      if (n.tagName === "A" && n.getAttribute("href")) { href = n.getAttribute("href"); text = n.textContent; break; }
      if (a) { href = a.getAttribute("href"); text = a.textContent; break; }
      n = n.parentElement;
    }
    return { label: e.getAttribute("aria-label") || e.getAttribute("title"), href, rowText: (text || "").trim().slice(0, 50) };
  });
  return JSON.stringify({ url: location.pathname, dockRows: d?.dataset.dockRows, dockRowStatus: d?.dataset.dockRowStatus, dockAnchor: d?.dataset.dockAnchor, dockExpanded: d?.dataset.dockExpanded, glyphs });
})()
