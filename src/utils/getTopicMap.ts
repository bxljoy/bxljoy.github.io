import { type CollectionEntry, getCollection } from "astro:content";
import { postFilter } from "./postFilter";
import {
  buildTopicMap,
  formatTopicProblems,
  getTopicForPost,
  validateTopicMap,
} from "./topics";

export type TopicWithPosts = {
  topic: CollectionEntry<"topics">;
  posts: CollectionEntry<"posts">[];
};

/**
 * Loads topics and posts, validates the topic map, and throws with every
 * problem listed if it is invalid, so any page that uses it fails the build.
 */
export async function getTopicMap() {
  const [topicEntries, postEntries] = await Promise.all([
    getCollection("topics"),
    getCollection("posts"),
  ]);

  const inputs = topicEntries.map(({ id, data }) => ({
    id,
    order: data.order,
    posts: data.posts,
  }));
  const publishedIds = postEntries.filter(postFilter).map(post => post.id);

  const problems = validateTopicMap(inputs, {
    all: postEntries.map(post => post.id),
    published: publishedIds,
  });
  if (problems.length > 0) throw new Error(formatTopicProblems(problems));

  const paths = buildTopicMap(inputs, publishedIds);
  const topicsById = new Map(topicEntries.map(topic => [topic.id, topic]));
  const postsById = new Map(postEntries.map(post => [post.id, post]));

  const topics: TopicWithPosts[] = paths.map(({ id, path }) => ({
    topic: topicsById.get(id)!,
    posts: path.map(postId => postsById.get(postId)!),
  }));

  function positionOf(postId: string) {
    const position = getTopicForPost(paths, postId);
    if (!position) return null;
    const lookup = (id: string | null) => (id ? postsById.get(id)! : null);
    return {
      topic: topicsById.get(position.topicId)!,
      number: position.index + 1,
      total: position.total,
      prev: lookup(position.prev),
      next: lookup(position.next),
    };
  }

  return { topics, positionOf };
}
