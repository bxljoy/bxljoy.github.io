/**
 * Pure topic-map logic: which posts belong to which topic, in what order.
 *
 * Topic files (src/content/topics/*.md) own membership and reading order via
 * their `posts` list of post ids. Kept free of `astro:*` imports so it can be
 * unit-tested; see `getTopicMap.ts` for the Astro-side loader.
 */

export type TopicInput = { id: string; order: number; posts: string[] };

export type TopicProblem =
  | { kind: "missing-post"; topic: string; post: string }
  | { kind: "orphan-post"; post: string }
  | { kind: "duplicate-post"; post: string; topics: string[] };

export type TopicPath = { id: string; path: string[] };

export type TopicPosition = {
  topicId: string;
  index: number;
  total: number;
  prev: string | null;
  next: string | null;
};

/**
 * Checks the invariants from SPEC-site.md:
 * every listed post exists, every published post is listed, and no post is
 * listed more than once. Drafts may be listed or unlisted freely.
 */
export function validateTopicMap(
  topics: TopicInput[],
  posts: { all: string[]; published: string[] }
): TopicProblem[] {
  const problems: TopicProblem[] = [];
  const allPosts = new Set(posts.all);
  const membership = new Map<string, string[]>();

  for (const topic of topics) {
    for (const post of topic.posts) {
      if (!allPosts.has(post)) {
        problems.push({ kind: "missing-post", topic: topic.id, post });
      }
      membership.set(post, [...(membership.get(post) ?? []), topic.id]);
    }
  }

  for (const post of posts.published) {
    if (!membership.has(post)) problems.push({ kind: "orphan-post", post });
  }

  for (const [post, inTopics] of membership) {
    if (inTopics.length > 1) {
      problems.push({ kind: "duplicate-post", post, topics: inTopics });
    }
  }

  return problems;
}

export function formatTopicProblems(problems: TopicProblem[]): string {
  const lines = problems.map(problem => {
    switch (problem.kind) {
      case "missing-post":
        return `- src/content/topics/${problem.topic}.md lists "${problem.post}", but no post has that id.`;
      case "orphan-post":
        return `- Post "${problem.post}" is published but not listed in any topic file.`;
      case "duplicate-post":
        return `- Post "${problem.post}" is listed more than once (topics: ${problem.topics.join(", ")}).`;
    }
  });
  return `Topic map is invalid:\n${lines.join("\n")}`;
}

/**
 * Topics sorted by `order`, each with its published posts in reading order.
 * Topics with no published posts are left out.
 */
export function buildTopicMap(
  topics: TopicInput[],
  publishedIds: string[]
): TopicPath[] {
  const published = new Set(publishedIds);
  return [...topics]
    .sort((a, b) => a.order - b.order)
    .map(topic => ({
      id: topic.id,
      path: topic.posts.filter(post => published.has(post)),
    }))
    .filter(topic => topic.path.length > 0);
}

export function getTopicForPost(
  map: TopicPath[],
  postId: string
): TopicPosition | null {
  for (const topic of map) {
    const index = topic.path.indexOf(postId);
    if (index === -1) continue;
    return {
      topicId: topic.id,
      index,
      total: topic.path.length,
      prev: topic.path[index - 1] ?? null,
      next: topic.path[index + 1] ?? null,
    };
  }
  return null;
}
