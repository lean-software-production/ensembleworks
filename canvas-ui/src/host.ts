// What a host gives the shared canvas session. Deliberately small: anything a
// host already owns (transport, presence stores, pages, embeds) stays with it.
export interface CanvasHost {
  /** System clipboard access for copy, cut and paste. */
  readonly clipboard: {
    read(): Promise<string>
    write(text: string): Promise<void>
  }
  /** Show a short user-visible message (a toast, or a console line). */
  readonly notify: (message: string) => void
  /** The pointer moved over the viewport, in viewport-local screen pixels.
   * Hosts forward it to their presence publisher. */
  readonly onCursorScreen: (point: { readonly x: number; readonly y: number }) => void
}
