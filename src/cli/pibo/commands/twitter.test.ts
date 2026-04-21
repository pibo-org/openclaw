import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../../config/home-env.test-harness.js";
import {
  TWITTER_STATE_SEEN_LIMIT,
  buildTweetUrl,
  collectTweetsFromPasses,
  createEmptyTwitterState,
  expandTweetsWithStatusPageText,
  hasFeedTweetShowMoreSignal,
  getLegacyTwitterLegacyStatePath,
  getTwitterStatePath,
  normalizeTwitterCheckOptions,
  readTwitterState,
  type Tweet,
  writeTwitterState,
} from "./twitter.js";

describe("pibo twitter command", () => {
  it("keeps feed state in separate files and trims seen ids", async () => {
    await withTempHome("openclaw-twitter-state-home-", async () => {
      const followingState = createEmptyTwitterState("following");
      followingState.seen = Array.from(
        { length: TWITTER_STATE_SEEN_LIMIT + 2 },
        (_, index) => `following-${index}`,
      );
      writeTwitterState("following", followingState);

      const forYouState = createEmptyTwitterState("for-you");
      forYouState.seen = ["for-you-1"];
      writeTwitterState("for-you", forYouState);

      const following = readTwitterState("following");
      const forYou = readTwitterState("for-you");

      expect(following.seen).toEqual(
        Array.from({ length: TWITTER_STATE_SEEN_LIMIT }, (_, index) => `following-${index + 2}`),
      );
      expect(forYou.seen).toEqual(["for-you-1"]);
      expect(await fs.readFile(getTwitterStatePath("following"), "utf8")).toContain(
        '"feed": "following"',
      );
      expect(await fs.readFile(getTwitterStatePath("for-you"), "utf8")).toContain(
        '"feed": "for-you"',
      );
    });
  });

  it("reads the legacy following state when the new feed state is absent", async () => {
    await withTempHome("openclaw-twitter-legacy-home-", async () => {
      const legacyPath = getLegacyTwitterLegacyStatePath();
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        JSON.stringify(
          {
            lastCheck: "2026-04-19T09:00:00.000Z",
            recentBuffer: ["legacy-1", "legacy-2"],
            lastTweetCount: 5,
            lastNewTweetCount: 2,
            status: "success",
          },
          null,
          2,
        ) + "\n",
      );

      const state = readTwitterState("following");

      expect(state.feed).toBe("following");
      expect(state.seen).toEqual(["legacy-1", "legacy-2"]);
      expect(state.lastTweetCount).toBe(5);
      expect(state.lastNewTweetCount).toBe(2);
      expect(state.notes).toContain("legacy");
    });
  });

  it("normalizes stateless and state-related flags", () => {
    expect(
      normalizeTwitterCheckOptions({
        new: "7",
        maxScanned: "80",
        stateless: true,
      }),
    ).toMatchObject({
      requestedNewCount: 7,
      maxScanned: 80,
      ignoreState: true,
      writeState: false,
    });

    expect(
      normalizeTwitterCheckOptions({
        ignoreState: true,
        noWriteState: true,
      }),
    ).toMatchObject({
      ignoreState: true,
      writeState: false,
    });
  });

  it("stops when the requested number of new tweets has been collected", async () => {
    const passes = [
      [
        {
          statusId: "seen-1",
          author: "@alice",
          text: "already seen",
          repostedFrom: null,
        },
        {
          statusId: "new-1",
          author: "@bob",
          text: "first new tweet",
          repostedFrom: null,
        },
      ],
      [
        {
          statusId: "new-1",
          author: "@bob",
          text: "first new tweet",
          repostedFrom: null,
        },
        {
          statusId: "new-2",
          author: "@carol",
          text: "second new tweet",
          repostedFrom: "@dave",
          hasFeedShowMore: true,
        },
      ],
    ];
    let passIndex = 0;

    const result = await collectTweetsFromPasses({
      feed: "following",
      knownStatusIds: ["seen-1"],
      requestedNewCount: 2,
      maxScanned: 10,
      loadPass: async () => passes[Math.min(passIndex, passes.length - 1)] ?? [],
      advance: async () => {
        passIndex += 1;
      },
    });

    expect(result.stopReason).toBe("target_reached");
    expect(result.totalScanned).toBe(3);
    expect(result.tweets.map((tweet) => tweet.statusId)).toEqual(["new-1", "new-2"]);
    expect(result.tweets[1]).toMatchObject({
      feed: "following",
      repostedFrom: "@dave",
    });
    expect(result.statusIdsMarkedForExpansion).toEqual(["new-2"]);
  });

  it("stops when the hard max scanned cap is reached", async () => {
    const passes = [
      [{ statusId: "1", author: "@alice", text: "one", repostedFrom: null }],
      [{ statusId: "2", author: "@bob", text: "two", repostedFrom: null }],
      [{ statusId: "3", author: "@carol", text: "three", repostedFrom: null }],
    ];
    let passIndex = 0;

    const result = await collectTweetsFromPasses({
      feed: "for-you",
      knownStatusIds: [],
      requestedNewCount: 5,
      maxScanned: 2,
      loadPass: async () => passes[Math.min(passIndex, passes.length - 1)] ?? [],
      advance: async () => {
        passIndex += 1;
      },
    });

    expect(result.stopReason).toBe("max_scanned_reached");
    expect(result.totalScanned).toBe(2);
    expect(result.tweets.map((tweet) => tweet.statusId)).toEqual(["1", "2"]);
  });

  it("stops on stagnation and keeps full raw text with a direct url", async () => {
    const longText = "x".repeat(260);
    const passes = [
      [{ statusId: "123", author: "@alice", text: longText, repostedFrom: null }],
      [],
      [],
    ];
    let passIndex = 0;

    const result = await collectTweetsFromPasses({
      feed: "following",
      knownStatusIds: [],
      requestedNewCount: 5,
      maxScanned: 50,
      stagnationPassLimit: 2,
      loadPass: async () => passes[Math.min(passIndex, passes.length - 1)] ?? [],
      advance: async () => {
        passIndex += 1;
      },
    });

    expect(result.stopReason).toBe("stagnated");
    expect(result.totalScanned).toBe(1);
    expect(result.tweets[0]).toMatchObject({
      statusId: "123",
      author: "@alice",
      text: longText,
      url: buildTweetUrl("@alice", "123"),
      feed: "following",
      repostedFrom: null,
    });
    expect(result.tweets[0]).not.toHaveProperty("tldr");
    expect(result.tweets[0]).not.toHaveProperty("category");
  });

  it("detects the feed article show more control with an exact label match", () => {
    expect(hasFeedTweetShowMoreSignal("Show more")).toBe(true);
    expect(hasFeedTweetShowMoreSignal("  Show more  ")).toBe(true);
    expect(hasFeedTweetShowMoreSignal("Show more replies")).toBe(false);
    expect(hasFeedTweetShowMoreSignal("Reply")).toBe(false);
  });

  it("expands only tweets marked by feed show more detection", async () => {
    const tweets: Tweet[] = [
      {
        statusId: "1",
        url: "https://x.com/alice/status/1",
        author: "@alice",
        text: "Preview only",
        feed: "following" as const,
        repostedFrom: null,
      },
      {
        statusId: "2",
        url: "https://x.com/bob/status/2",
        author: "@bob",
        text: "Already complete",
        feed: "following" as const,
        repostedFrom: null,
      },
      {
        statusId: "3",
        url: "https://x.com/carol/status/3",
        author: "@carol",
        text: "Keep on fetch failure",
        feed: "following" as const,
        repostedFrom: null,
      },
    ];

    const fetchStatusPageText = vi.fn(async (tweet: Tweet) => {
      switch (tweet.statusId) {
        case "1":
          return "Preview only with the full public status-page text attached";
        case "3":
          throw new Error("status page unavailable");
        default:
          throw new Error(`unexpected fetch for ${tweet.statusId}`);
      }
    });

    const expanded = await expandTweetsWithStatusPageText(tweets, ["1", "3"], fetchStatusPageText);

    expect(expanded).toEqual([
      {
        ...tweets[0],
        text: "Preview only with the full public status-page text attached",
      },
      tweets[1],
      tweets[2],
    ]);
    expect(fetchStatusPageText).toHaveBeenCalledTimes(2);
    expect(fetchStatusPageText).toHaveBeenNthCalledWith(1, tweets[0]);
    expect(fetchStatusPageText).toHaveBeenNthCalledWith(2, tweets[2]);
  });
});
