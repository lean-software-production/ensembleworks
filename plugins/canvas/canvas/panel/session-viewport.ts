import { useEffect, useRef, useState } from "react";
import type { ViewportSize } from "@ensembleworks/canvas-react";

export function useSessionViewport() {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState<ViewportSize>({
    width: 1024,
    height: 768,
  });
  const viewportSizeRef = useRef(viewportSize);
  viewportSizeRef.current = viewportSize;
  const [columnWidth, setColumnWidth] = useState(0);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    setColumnWidth(element.clientWidth);
    setViewportSize({
      width: element.clientWidth || 1024,
      height: element.clientHeight || 768,
    });
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setColumnWidth(entry.contentRect.width);
      setViewportSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { panelRef, viewportRef, viewportSize, viewportSizeRef, columnWidth };
}
