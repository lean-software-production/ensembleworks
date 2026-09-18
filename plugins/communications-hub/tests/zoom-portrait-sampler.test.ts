import { afterEach, expect, it, vi } from "vitest";
import { ZoomPortraitSampler } from "../src/adapters/zoom-portrait-sampler.js";

afterEach(() => vi.useRealTimers());
function setup() {
  vi.useFakeTimers();
  const send = vi.fn();
  const sampler = new ZoomPortraitSampler(send);
  const speak = (id: string) => sampler.event({ kind: "speaking", participantId: id, at: Date.now() });
  return { sampler, send, speak };
}
it("waits for readiness, captures once, and stays unsubscribed between refreshes", () => {
  const { sampler, send, speak } = setup();
  speak("1");
  expect(send).not.toHaveBeenCalled();
  sampler.start();
  expect(send.mock.calls).toEqual([["1", true]]);
  sampler.captured("2");
  expect(sampler.wants("1")).toBe(true);
  sampler.captured("1");
  expect(send.mock.calls.at(-1)).toEqual(["1", false]);
  speak("1");
  vi.advanceTimersByTime(29_999);
  speak("1");
  expect(send).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(1);
  speak("1");
  expect(send.mock.calls.at(-1)).toEqual(["1", true]);
  sampler.reset();
});
it("switches speakers, ignores late frames, and bounds a missing frame to five seconds", () => {
  const { sampler, send, speak } = setup();
  sampler.start(); speak("1"); speak("2");
  expect(send.mock.calls).toEqual([["1", true], ["1", false], ["2", true]]);
  expect(sampler.wants("1")).toBe(false);
  vi.advanceTimersByTime(5_000);
  expect(send.mock.calls.at(-1)).toEqual(["2", false]);
  expect(sampler.wants("2")).toBe(false);
});
it("stops on camera-off, leave, and rejection; reset cancels all callbacks", () => {
  const { sampler, send, speak } = setup();
  sampler.start(); speak("1");
  sampler.event({ kind: "camera", participantId: "1", on: false, at: Date.now() });
  expect(send.mock.calls.at(-1)).toEqual(["1", false]);
  speak("2"); sampler.rejected("2");
  expect(send.mock.calls.at(-1)).toEqual(["2", false]);
  speak("3"); sampler.event({ kind: "left", participantId: "3", at: Date.now() });
  expect(send.mock.calls.at(-1)).toEqual(["3", false]);
  speak("4"); sampler.reset(); send.mockClear();
  vi.advanceTimersByTime(60_000);
  expect(send).not.toHaveBeenCalled();
});
