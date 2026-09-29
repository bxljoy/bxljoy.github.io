import { defineAstroPaperConfig } from "./src/types/config";

export default defineAstroPaperConfig({
  site: {
    url: "https://bxljoy.github.io/",
    title: "Alex Bao's Blog",
    description:
      "Notes on backend engineering, databases, distributed systems, and AI coding agents — organized as learning paths.",
    author: "Alex Bao",
    profile: "https://github.com/bxljoy",
    ogImage: "default-og.jpg",
    lang: "en",
    timezone: "Europe/Stockholm",
    dir: "ltr",
  },
  posts: {
    perPage: 10,
    perIndex: 5,
    scheduledPostMargin: 15 * 60 * 1000,
  },
  features: {
    lightAndDarkMode: true,
    dynamicOgImage: true,
    showArchives: true,
    showBackButton: true,
    editPost: { enabled: false },
    search: "pagefind",
  },
  socials: [
    { name: "github",   url: "https://github.com/bxljoy" },
    { name: "linkedin", url: "https://www.linkedin.com/in/xiaolei-bao-aa4b7b257/" },
  ],
  shareLinks: [
    { name: "linkedin", url: "https://www.linkedin.com/sharing/share-offsite/?url=" },
    { name: "x",        url: "https://x.com/intent/post?url=" },
    { name: "mail",     url: "mailto:?subject=See%20this%20post&body=" },
  ],
});
