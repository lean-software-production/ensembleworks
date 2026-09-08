(() => {
  const a=document.querySelector('a[data-sidebar-thread-id="thr_cjnyuqz388"]');
  const row=a.closest("div");
  const deco=row.querySelector("[data-canvas-row-presence]");
  const fade=row.querySelector(".bb-sidebar-hover-actions-fade");
  const acts=row.querySelector(".bb-sidebar-hover-actions");
  const d=deco?deco.getBoundingClientRect():null;
  const btns=[...row.querySelectorAll("button")].map(b=>{const r=b.getBoundingClientRect();return {label:(b.getAttribute("aria-label")||b.textContent||"").trim().slice(0,30), x:Math.round(r.x), w:Math.round(r.width), vis:getComputedStyle(b).visibility, op:getComputedStyle(b.closest(".bb-sidebar-hover-actions")||b).opacity};});
  return JSON.stringify({
    hovered: row.matches(":hover"),
    fadeOpacity: fade?getComputedStyle(fade).opacity:null,
    actionsOpacity: acts?getComputedStyle(acts).opacity:null,
    insetPaddingRight: getComputedStyle(row.querySelector("span.bb-sidebar-hover-actions-inset")).paddingRight,
    decoPresent: !!deco,
    decoAria: deco?deco.getAttribute("aria-label"):null,
    decoTitle: deco?deco.title:null,
    decoLeading: deco?deco.parentElement.firstChild===deco:null,
    decoBox: d?{x:Math.round(d.x),y:Math.round(d.y),w:Math.round(d.width),h:Math.round(d.height)}:null,
    decoVisible: deco? (getComputedStyle(deco).visibility+"/"+getComputedStyle(deco).opacity+"/"+getComputedStyle(deco).display) : null,
    faces: deco?[...deco.querySelectorAll(".canvas-row-face")].map(f=>f.textContent+"|"+getComputedStyle(f).backgroundColor+"|op="+getComputedStyle(f).opacity):[],
    titleWidth: Math.round(row.querySelector("span.min-w-0.truncate").getBoundingClientRect().width),
    buttons: btns
  });
})()
