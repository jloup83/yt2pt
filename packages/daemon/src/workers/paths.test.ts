import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sanitize,
  formatDate,
  channelSlugFromFolderName,
  youtubeUrl,
} from "./paths";

describe("worker paths helpers", () => {
  it("sanitize() lowercases, strips accents, and replaces spaces", () => {
    assert.equal(sanitize("Père Phi"), "pere_phi");
    assert.equal(sanitize("  Hello,  World!  "), "hello_world");
    assert.equal(sanitize("Nikos Sotirakópoulos"), "nikos_sotirakopoulos");
  });

  it("formatDate() formats yyyymmdd as YYYY-MM-DD", () => {
    assert.equal(formatDate("20260411"), "2026-04-11");
  });

  it("youtubeUrl() builds the canonical watch URL", () => {
    assert.equal(
      youtubeUrl("q5Mq4kEa7pA"),
      "https://www.youtube.com/watch?v=q5Mq4kEa7pA"
    );
  });

  describe("channelSlugFromFolderName()", () => {
    it("extracts the channel slug from a well-formed folder name", () => {
      assert.equal(
        channelSlugFromFolderName(
          "fatherphi_2026-01-29_day_6_maybe_the_chatgpt_limit_really_is_just_200_now_[q5Mq4kEa7pA]"
        ),
        "fatherphi"
      );
      assert.equal(
        channelSlugFromFolderName(
          "nikos_sotirakopoulos_2026-04-11_is_fascism_left_or_right_wing_[q5XaN1JpfMQ]"
        ),
        "nikos_sotirakopoulos"
      );
    });

    it("returns null for malformed names", () => {
      assert.equal(channelSlugFromFolderName("no-date-here"), null);
      assert.equal(channelSlugFromFolderName(""), null);
    });
  });
});
