import { describe, expect, it } from "vitest";
import {
  buildTopicMap,
  formatTopicProblems,
  getTopicForPost,
  validateTopicMap,
} from "./topics";

const topic = (id: string, posts: string[], order = 1) => ({
  id,
  order,
  posts,
});

describe("validateTopicMap", () => {
  it("accepts a map where every published post is in exactly one topic", () => {
    const problems = validateTopicMap(
      [topic("pg", ["a", "b"]), topic("java", ["c"])],
      { all: ["a", "b", "c"], published: ["a", "b", "c"] }
    );
    expect(problems).toEqual([]);
  });

  it("reports a topic slug that matches no post", () => {
    const problems = validateTopicMap([topic("pg", ["a", "typo"])], {
      all: ["a"],
      published: ["a"],
    });
    expect(problems).toEqual([
      { kind: "missing-post", topic: "pg", post: "typo" },
    ]);
  });

  it("reports a published post that belongs to no topic", () => {
    const problems = validateTopicMap([topic("pg", ["a"])], {
      all: ["a", "b"],
      published: ["a", "b"],
    });
    expect(problems).toEqual([{ kind: "orphan-post", post: "b" }]);
  });

  it("does not report an unlisted draft as an orphan", () => {
    const problems = validateTopicMap([topic("pg", ["a"])], {
      all: ["a", "draft"],
      published: ["a"],
    });
    expect(problems).toEqual([]);
  });

  it("reports a post listed in two topics, or twice in one", () => {
    const problems = validateTopicMap(
      [topic("pg", ["a", "a"]), topic("java", ["a"])],
      { all: ["a"], published: ["a"] }
    );
    expect(problems).toEqual([
      { kind: "duplicate-post", post: "a", topics: ["pg", "pg", "java"] },
    ]);
  });

  it("reports every problem at once", () => {
    const problems = validateTopicMap([topic("pg", ["x"])], {
      all: ["a"],
      published: ["a"],
    });
    expect(problems.map(p => p.kind)).toEqual(["missing-post", "orphan-post"]);
  });
});

describe("formatTopicProblems", () => {
  it("names the topic file and post for each problem", () => {
    const message = formatTopicProblems([
      { kind: "missing-post", topic: "pg", post: "typo" },
      { kind: "orphan-post", post: "b" },
      { kind: "duplicate-post", post: "a", topics: ["pg", "java"] },
    ]);
    expect(message).toContain("src/content/topics/pg.md");
    expect(message).toContain('"typo"');
    expect(message).toContain('"b"');
    expect(message).toContain("pg, java");
  });
});

describe("buildTopicMap", () => {
  it("keeps topic-file order and drops drafts from the reading path", () => {
    const map = buildTopicMap([topic("pg", ["c", "draft", "a"])], ["a", "c"]);
    expect(map[0].path).toEqual(["c", "a"]);
  });

  it("sorts topics by order and hides topics with no published posts", () => {
    const map = buildTopicMap(
      [
        topic("b", ["b1"], 2),
        topic("empty", ["draft"], 0),
        topic("a", ["a1"], 1),
      ],
      ["a1", "b1"]
    );
    expect(map.map(t => t.id)).toEqual(["a", "b"]);
  });
});

describe("getTopicForPost", () => {
  const map = buildTopicMap([topic("pg", ["a", "b", "c"])], ["a", "b", "c"]);

  it("gives position, total and neighbours inside the topic", () => {
    expect(getTopicForPost(map, "b")).toEqual({
      topicId: "pg",
      index: 1,
      total: 3,
      prev: "a",
      next: "c",
    });
  });

  it("has no prev at the start and no next at the end", () => {
    expect(getTopicForPost(map, "a")).toMatchObject({ prev: null, next: "b" });
    expect(getTopicForPost(map, "c")).toMatchObject({ prev: "b", next: null });
  });

  it("returns null for a post that is in no visible topic", () => {
    expect(getTopicForPost(map, "zzz")).toBeNull();
  });
});
