/**
 * panel-locus.test.ts — where a streamed panel renders, as pure rules
 * (src/renderer/help/panel-locus.ts, his order 2026-10-04): the web picks the
 * CLOUD browser worker, the desktop its own machine, an explicit request
 * wins; the locus rides panel.open; only a desktop panel checks attach; and
 * a cloud panel's dead ends are the worker's cards, never the desktop's.
 */
import { describe, expect, it } from "vitest";
import {
  pickPanelLocus, panelNeedsDesktop, panelOpenParams, panelDeadCard, PANEL_CONNECT_COPY, type PanelDeadCause,
} from "../../src/renderer/help/panel-locus";

describe("pickPanelLocus", () => {
  it("the web opens on the cloud, the desktop on itself", () => {
    expect(pickPanelLocus({ web: true })).toBe("cloud");
    expect(pickPanelLocus({ web: false })).toBe("desktop");
  });
  it("an explicit request wins on either surface", () => {
    expect(pickPanelLocus({ web: true, requested: "desktop" })).toBe("desktop");
    expect(pickPanelLocus({ web: false, requested: "cloud" })).toBe("cloud");
    expect(pickPanelLocus({ web: true, requested: undefined })).toBe("cloud");
  });
});

describe("panelNeedsDesktop + panelOpenParams", () => {
  it("only a desktop panel asks whether the desktop is attached", () => {
    expect(panelNeedsDesktop("desktop")).toBe(true);
    expect(panelNeedsDesktop("cloud")).toBe(false);
  });
  it("panel.open carries the same shape on both sources plus the locus", () => {
    const open = { url: "https://claude.ai", width: 1280, height: 800, quality: 70 };
    expect(panelOpenParams("cloud", open)).toEqual({ ...open, locus: "cloud" });
    expect(panelOpenParams("desktop", open)).toEqual({ ...open, locus: "desktop" });
  });
  it("the connect copy names the source", () => {
    expect(PANEL_CONNECT_COPY.cloud).toMatch(/cloud browser/i);
    expect(PANEL_CONNECT_COPY.desktop).toMatch(/desktop/i);
  });
});

describe("panelDeadCard", () => {
  const causes: PanelDeadCause[] = ["desktop-offline", "connect-failed", "open-failed", "dropped", "machine-detached"];

  it("signed out is the same card everywhere", () => {
    expect(panelDeadCard("cloud", "signed-out")).toEqual({ state: "signed-out" });
    expect(panelDeadCard("desktop", "signed-out")).toEqual({ state: "signed-out" });
  });

  it("a cloud panel never shows a desktop card: every dead end is the worker's", () => {
    for (const cause of causes) {
      const card = panelDeadCard("cloud", cause, "no worker image");
      expect(card.state).toBe("worker-unavailable");
      expect(card.detail).toBeTruthy();
      expect(card.detail).not.toMatch(/desktop/i);
    }
    expect(panelDeadCard("cloud", "open-failed", "the farm refused").detail).toContain("the farm refused");
    expect(panelDeadCard("cloud", "open-failed").detail).toMatch(/none could take it/);
    expect(panelDeadCard("cloud", "dropped").detail).toMatch(/went away/);
  });

  it("a desktop panel keeps its cards: offline, dropped, detached, failed", () => {
    expect(panelDeadCard("desktop", "desktop-offline")).toEqual({ state: "desktop-offline" });
    expect(panelDeadCard("desktop", "connect-failed")).toEqual({ state: "disconnected" });
    expect(panelDeadCard("desktop", "dropped")).toEqual({ state: "disconnected" });
    expect(panelDeadCard("desktop", "machine-detached")).toMatchObject({ state: "disconnected", detail: expect.stringMatching(/detached/) });
    expect(panelDeadCard("desktop", "open-failed", "refused")).toEqual({ state: "failed", detail: "refused" });
    expect(panelDeadCard("desktop", "open-failed")).toEqual({ state: "failed" });
  });
});
