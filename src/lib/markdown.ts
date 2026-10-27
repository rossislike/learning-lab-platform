// Scenario markdown pipeline, shared by components/Markdown.tsx and its test
// (src/lib/markdown.test.mjs). Scenario text is repo-reviewed today, but it is
// rendered on the app origin next to the learner's session credentials, so
// raw HTML goes through rehype-sanitize after rehype-raw. The default schema
// (GitHub's) keeps <details>/<summary> (with `open`), GFM task-list
// checkboxes and `language-*` classes on <code>; it drops <script>,
// <iframe>, <style>, <form>, event handlers and javascript: URLs.

import type { Options } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

export const sanitizeSchema = defaultSchema;

type PluggableList = NonNullable<Options["rehypePlugins"]>;

export const remarkPlugins: PluggableList = [remarkGfm];
export const rehypePlugins: PluggableList = [rehypeRaw, [rehypeSanitize, sanitizeSchema]];

/** Fenced code blocks in these languages get a "run in terminal" button. */
export function isRunnableLanguage(className: string | undefined) {
  return /(^|\s)language-(bash|sh|shell|zsh)(\s|$)/.test(className ?? "");
}
