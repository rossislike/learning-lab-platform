import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { isRunnableLanguage, rehypePlugins, remarkPlugins } from "./markdown.ts";

function render(markdown) {
  return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins, rehypePlugins }, markdown));
}

test("keeps <details>/<summary>, task lists and language classes", () => {
  const html = render(
    [
      "<details open><summary>Hint</summary>",
      "",
      "Use `git add`.",
      "",
      "</details>",
      "",
      "- [x] done",
      "- [ ] todo",
      "",
      "```bash",
      "git status",
      "```",
    ].join("\n")
  );
  assert.match(html, /<details open="">/);
  assert.match(html, /<summary>Hint<\/summary>/);
  assert.match(html, /<input type="checkbox" disabled="" checked=""\/>/);
  assert.match(html, /<code class="language-bash">git status/);
});

test("drops scripts, frames, styles, forms, handlers and javascript: URLs", () => {
  const html = render(
    [
      "<script>alert(1)</script>",
      '<script async src="https://evil.example/x.js"></script>',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      "<style>body{display:none}</style>",
      '<meta http-equiv="refresh" content="0;url=https://evil.example">',
      '<form action="https://evil.example"><input name="password"></form>',
      '<img src="x" onerror="alert(1)">',
      '<a href="javascript:alert(1)">click</a>',
      '<div style="position:fixed;inset:0">overlay</div>',
    ].join("\n\n")
  );
  for (const forbidden of ["<script", "<iframe", "srcdoc", "<style", "<meta", "<form", "onerror", "javascript:", "style="]) {
    assert.equal(html.includes(forbidden), false, `${forbidden} survived: ${html}`);
  }
  assert.match(html, />click</);
});

test("runnable fences are shell languages only", () => {
  for (const language of ["bash", "sh", "shell", "zsh"]) assert.equal(isRunnableLanguage(`language-${language}`), true);
  for (const language of ["console", "js", "bashrc", "text"]) assert.equal(isRunnableLanguage(`language-${language}`), false);
  assert.equal(isRunnableLanguage(undefined), false);
});
