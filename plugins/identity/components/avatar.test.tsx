// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Avatar, avatarUrl } from "./Avatar.js";
import { readableInk } from "../person-colors.js";

afterEach(cleanup);

describe("Avatar", () => {
  it("shows the GitHub photo in a circle on the person's colour", () => {
    const { container } = render(<Avatar github="matt" displayName="Matt Example" color="#2f6bb8" size={26} />);
    const wrapper = container.firstElementChild as HTMLSpanElement;
    const img = wrapper.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(avatarUrl("matt", 26));
    expect(img.getAttribute("alt")).toBe("");
    expect(wrapper.style.width).toBe("26px");
    expect(wrapper.style.height).toBe("26px");
    expect(wrapper.style.borderRadius).toBe("50%");
    expect(wrapper.style.background).toBe("rgb(47, 107, 184)");
    expect(wrapper.textContent).toBe("");
  });

  it("falls back to initials in adaptive ink only when the photo fails to load", () => {
    const { container } = render(<Avatar github="matt" displayName="Matt Example" color="#ffff00" size={20} />);
    const wrapper = container.firstElementChild as HTMLSpanElement;
    fireEvent.error(wrapper.querySelector("img")!);
    expect(wrapper.querySelector("img")).toBeNull();
    expect(wrapper.textContent).toBe("ME");
    expect(wrapper.style.color).toBe(readableInk("#ffff00"));
  });

  it("shows the fallback text straight away when there is no GitHub handle", () => {
    const { container } = render(<Avatar github={null} displayName="?" fallback="?" color="#5b6570" size={26} />);
    const wrapper = container.firstElementChild as HTMLSpanElement;
    expect(wrapper.querySelector("img")).toBeNull();
    expect(wrapper.textContent).toBe("?");
  });

  it("requests a 2x image so the circle stays sharp on dense screens", () => {
    expect(avatarUrl("matt", 20)).toBe("https://github.com/matt.png?size=40");
    expect(avatarUrl("odd name", 32)).toBe("https://github.com/odd%20name.png?size=64");
  });

  it("passes extra attributes and style through to the wrapper", () => {
    const { container } = render(
      <Avatar github="matt" displayName="Matt" color="#2f6bb8" size={20} data-identity-bubble="viewer" style={{ zIndex: 9, marginLeft: -6 }} />,
    );
    const wrapper = container.firstElementChild as HTMLSpanElement;
    expect(wrapper.getAttribute("data-identity-bubble")).toBe("viewer");
    expect(wrapper.style.zIndex).toBe("9");
    expect(wrapper.style.marginLeft).toBe("-6px");
    expect(wrapper.style.width).toBe("20px");
  });
});
