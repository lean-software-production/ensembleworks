import { useEffect, useState, type CSSProperties, type HTMLAttributes } from "react";
import { initials } from "../presence-labels.js";
import { readableInk } from "../person-colors.js";

/**
 * One person, as a circle: their GitHub photo on their colour, or their initials in
 * adaptive ink when the photo cannot be shown.
 *
 * This is the ONLY place a person's picture is drawn. The header bubbles, the popover's
 * viewer list and the People roster all use it, so "photo first, initials only when
 * there is no photo" holds everywhere at once instead of per call site.
 *
 * The person's colour is always the fill: it shows while the photo loads, behind a
 * transparent photo, and as the initials' background. Callers add the ring (the typing
 * highlight, the stacking offset) through `style`.
 */
export function avatarUrl(github: string, size: number): string {
  // 2x the drawn size, so the circle is sharp on dense screens.
  return `https://github.com/${encodeURIComponent(github)}.png?size=${size * 2}`;
}

type AvatarProps = Omit<HTMLAttributes<HTMLSpanElement>, "color"> & {
  /** The GitHub handle, or null when nobody is known (the fallback shows at once). */
  github: string | null;
  displayName: string;
  /** The fill, a `#rrggbb` from `resolvePersonColor`. */
  color: string;
  /** Drawn diameter in px. */
  size: number;
  /** Initials font size; defaults to a size that suits the diameter. */
  fontSize?: number;
  /** The text shown instead of the photo; defaults to the display name's initials. */
  fallback?: string;
};

export function Avatar({ github, displayName, color, size, fontSize, fallback, style, ...rest }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  // A new handle gets a fresh try; a failure for one person must not stick to the next.
  useEffect(() => setFailed(false), [github]);
  const showPhoto = github !== null && github.length > 0 && !failed;
  const base: CSSProperties = {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: size, height: size, borderRadius: "50%", flex: "0 0 auto",
    overflow: "hidden", boxSizing: "border-box",
    background: color, color: readableInk(color),
    fontSize: fontSize ?? Math.round(size * 0.4), fontWeight: 700,
  };
  return (
    <span aria-hidden="true" {...rest} style={{ ...base, ...style }}>
      {showPhoto ? (
        <img
          src={avatarUrl(github, size)}
          alt=""
          width={size}
          height={size}
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (fallback ?? initials(displayName))}
    </span>
  );
}
