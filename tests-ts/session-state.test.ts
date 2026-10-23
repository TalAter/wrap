import { describe, expect, test } from "bun:test";
import { type AppState, isDialogTag } from "../src/session/state.ts";

describe("isDialogTag", () => {
  const dialogTags: AppState["tag"][] = [
    "confirming",
    "editing",
    "composing-followup",
    "processing-followup",
    "composing-interactive",
    "processing-interactive",
    "executing-step",
  ];

  const nonDialogTags: AppState["tag"][] = ["thinking", "editor-handoff", "exiting"];

  test.each(dialogTags)("returns true for dialog tag %s", (tag) => {
    expect(isDialogTag(tag)).toBe(true);
  });

  test.each(nonDialogTags)("returns false for non-dialog tag %s", (tag) => {
    expect(isDialogTag(tag)).toBe(false);
  });
});
