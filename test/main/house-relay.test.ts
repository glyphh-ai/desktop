/**
 * house-relay.test.ts — the house apps as rules (src/renderer/help/
 * house-relay.ts): the slug → view table the ⋮ menu and the Skills page
 * read, and that it names the same six apps the shared store does.
 */
import { describe, expect, it } from "vitest";
import { HOUSE_VIEW_OF_APP, HOUSE_TOOL_VIEWS, HOUSE_APPS, houseViewOf } from "../../src/renderer/help/house-relay.js";
import { HOUSE_VIEW_OF_APP as SHARED_HOUSE_VIEW_OF_APP } from "../../src/shared/house-store.js";

describe("the house apps", () => {
  it("six house apps, each a built-in work panel both surfaces host themselves", () => {
    expect(HOUSE_VIEW_OF_APP).toEqual({ design: "gdesign", slides: "gpoint", images: "gimage", video: "gvideo", audio: "gsound", drive: "gdrive" });
    expect([...HOUSE_APPS].sort()).toEqual(["audio", "design", "drive", "images", "slides", "video"]);
    expect([...HOUSE_TOOL_VIEWS].sort()).toEqual(["gdesign", "gdrive", "gimage", "gpoint", "gsound", "gvideo"]);
    // The renderer's copy and the shared table (which the renderer never
    // imports; main and the web stamp it onto an instance's tab) are one table.
    expect(HOUSE_VIEW_OF_APP).toEqual(SHARED_HOUSE_VIEW_OF_APP);
  });

  it("houseViewOf answers a house tool and nothing else", () => {
    expect(houseViewOf("gdesign")).toBe("gdesign");
    expect(houseViewOf("gimage")).toBe("gimage");
    for (const bad of ["preview", "files", "terminal", "", undefined, null, 42, "GDESIGN"]) expect(houseViewOf(bad)).toBeNull();
  });
});
