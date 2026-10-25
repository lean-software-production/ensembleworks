import { createRoot } from "react-dom/client";
import "../app.js";
import { ComposerBanner, Header, IdentityPrompt, Settings, screen, showHeader } from "./runtime.js";
createRoot(document.getElementById("root")!).render(screen === "settings"
  ? <main style={{ padding: 16 }}><Settings /></main>
  : screen === "composer"
    ? <main style={{ padding: 16 }}><div style={{ border: "1px solid var(--border, #ccc)", borderRadius: 8, padding: 12 }}><ComposerBanner /></div></main>
    : <>
      {showHeader
        ? <header><span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>A thread with a useful title</span><Header threadId="fixture" /></header>
        : <main>Another BB screen with no thread header</main>}
      <IdentityPrompt />
      <button style={{ position: "fixed", bottom: 24, left: 24 }}>Outside</button>
    </>);
