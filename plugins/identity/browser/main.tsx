import { createRoot } from "react-dom/client";
import "../app.js";
import { Header, IdentityPrompt, showHeader } from "./runtime.js";
createRoot(document.getElementById("root")!).render(<>
  {showHeader
    ? <header><span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>A thread with a useful title</span><Header threadId="fixture" /></header>
    : <main>Another BB screen with no thread header</main>}
  <IdentityPrompt />
  <button style={{ position: "fixed", bottom: 24, left: 24 }}>Outside</button>
</>);
