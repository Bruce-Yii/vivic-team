// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { BackgroundLayer } from "../BackgroundLayer";

const preferences = vi.hoisted(() => ({ current: { reducedMotion: false } as Record<string, unknown> }));
vi.mock("@/state/canvasStore", () => ({ useDisplayPreferences: () => preferences.current,
  useVivicState: (selector: (state: unknown) => unknown) => selector({ stage: "WORKSPACE", activity: null, focus: null }) }));
vi.mock("motion/react", () => ({ useReducedMotion: () => false }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });
const layer = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-vivic-layer="background"]')!;
// jsdom's CSS parser drops gradient functions, so the live assertion checks the composited
// fallback properties jsdom preserves; the gradient text is verified from server markup.
const cssSky = (host: HTMLElement) => layer(host).style;

it("falls back to the composited CSS sky, without throwing, when WebGL2 is unavailable", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  preferences.current = { reducedMotion: false };
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  expect(renderToStaticMarkup(<BackgroundLayer theme="dark" />)).toContain("radial-gradient");
  for (const theme of ["dark", "light", "dark"] as const) {
    await act(async () => root.render(<BackgroundLayer theme={theme} />));
    expect(layer(host).dataset.vivicAtmosphereTheme).toBe(theme);
    expect(layer(host).dataset.spaceRunning).toBe("true");
    expect(layer(host).className).toContain("hark-canvas-backdrop");
    expect(cssSky(host).backgroundColor).toMatch(/^rgb\(/);
    expect(cssSky(host).getPropertyValue("--space-light-strength")).not.toBe("");
    expect(host.querySelector("canvas")).not.toBeNull();
    expect(getContext).toHaveBeenCalledWith("webgl2", expect.any(Object));
  }
  await act(async () => root.unmount());
  expect(host.querySelector("canvas")).toBeNull();
  expect(errors).not.toHaveBeenCalled();
});

it("keeps palette and reduced-motion preferences synchronized without creating WebGL while reduced", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  preferences.current = { reducedMotion: true };
  await act(async () => root.render(<BackgroundLayer theme="dark" />));
  expect(layer(host).dataset.vivicAtmosphere).toBe("midnight");
  expect(layer(host).dataset.reducedMotion).toBe("true");
  expect(layer(host).dataset.spaceRunning).toBe("false");
  expect(cssSky(host).backgroundColor).toMatch(/^rgb\(/);
  expect(host.querySelector("canvas")).toBeNull();
  expect(getContext).not.toHaveBeenCalled();
  preferences.current = { reducedMotion: false, lightPalette: "mint" };
  await act(async () => root.render(<BackgroundLayer theme="light" />));
  expect(layer(host).dataset.vivicAtmosphere).toBe("mint");
  expect(layer(host).hasAttribute("data-reduced-motion")).toBe(false);
  expect(layer(host).dataset.spaceRunning).toBe("true");
  expect(host.querySelector("canvas")).not.toBeNull();
  expect(getContext).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  expect(host.querySelector("canvas")).toBeNull();
});
