/**
 * The refusal of 2026-09-17, pinned: every connector call came back "User not
 * allowed to call this tool" because we addressed a gateway tool by the app
 * slug while the gateway names it after the SERVER — and the proxy refuses a
 * server it cannot resolve.
 */

import { describe, it, expect } from "vitest";
import { pickToolName, bareToolName, toolsOfApp } from "../../src/main/gateway-tool-name";

// Names exactly as the gateway registers them for a Pipedream connection.
const NAMES = [
  "pd_o527_google_drive_u_eb46-list_files",
  "pd_o527_google_drive_u_eb46-get_file",
  "pd_o527_gmail_u_eb46-search_threads",
  "pd_o527_gmail_u_eb46-send_email",
  "pd_o527_google_calendar-list_events",
  "pd_o527_google_calendar-create_event",
];

describe("finding the gateway's own name for a tool", () => {
  it("resolves the app-slug form we used to send", () => {
    expect(pickToolName(NAMES, "google_drive", "list_files")).toBe("pd_o527_google_drive_u_eb46-list_files");
    expect(pickToolName(NAMES, "gmail", "search_threads")).toBe("pd_o527_gmail_u_eb46-search_threads");
    expect(pickToolName(NAMES, "google_calendar", "list_events")).toBe("pd_o527_google_calendar-list_events");
  });

  it("takes an exact name as given, without second-guessing the caller", () => {
    expect(pickToolName(NAMES, "gmail", "pd_o527_gmail_u_eb46-send_email")).toBe("pd_o527_gmail_u_eb46-send_email");
  });

  it("accepts the slug-prefixed form an agent might send", () => {
    expect(pickToolName(NAMES, "gmail", "gmail-search_threads")).toBe("pd_o527_gmail_u_eb46-search_threads");
  });

  it("never answers from another app that happens to share a verb", () => {
    // Both Drive and Calendar have a "list_…" tool; the app decides.
    expect(pickToolName(NAMES, "google_calendar", "list_files")).toBeNull();
    expect(pickToolName(NAMES, "gmail", "list_events")).toBeNull();
  });

  it("returns null for a tool the app does not have, rather than a near miss", () => {
    expect(pickToolName(NAMES, "gmail", "delete_everything")).toBeNull();
  });

  it("returns null when the app has no server at all", () => {
    expect(pickToolName(NAMES, "slack", "post_message")).toBeNull();
    expect(pickToolName([], "gmail", "search_threads")).toBeNull();
  });

  it("is case-insensitive about the app", () => {
    expect(pickToolName(NAMES, "Google_Drive", "get_file")).toBe("pd_o527_google_drive_u_eb46-get_file");
  });

  it("strips a server prefix down to the tool's own name", () => {
    expect(bareToolName("pd_o527_gmail_u_eb46-search_threads")).toBe("search_threads");
    expect(bareToolName("search_threads")).toBe("search_threads");
  });

  it("can list what an app does have, for an error worth reading", () => {
    expect(toolsOfApp(NAMES, "gmail")).toEqual([
      "pd_o527_gmail_u_eb46-search_threads",
      "pd_o527_gmail_u_eb46-send_email",
    ]);
    expect(toolsOfApp(NAMES, "slack")).toEqual([]);
  });
});
