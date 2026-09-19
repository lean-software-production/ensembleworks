import { createRoot } from "react-dom/client";
import "../app.js";
import { Header } from "./runtime.js";
createRoot(document.getElementById("root")!).render(<>
  <header><span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>A thread with a useful title</span><Header threadId="fixture" /></header>
  <button style={{ position: "fixed", bottom: 24, left: 24 }}>Outside</button>
</>);
