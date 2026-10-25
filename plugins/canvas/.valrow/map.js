(() => { const d=document.getElementById("canvas-av-dock");
 const m=[...document.querySelectorAll("[data-canvas-row-presence]")].map(n=>[n.closest("div")?.querySelector("a[data-sidebar-thread-id]")?.dataset.sidebarThreadId, n.getAttribute("aria-label")]);
 return JSON.stringify({writes:d.dataset.dockRowWrites, rows:d.dataset.dockRows, decor:d.dataset.dockRowDecor, map:m}); })()
