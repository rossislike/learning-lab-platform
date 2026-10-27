import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { isRunnableLanguage, rehypePlugins, remarkPlugins } from "../lib/markdown";

type Props = { content: string; onRun?: (command: string) => void };

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

/** Scenario markdown: GFM, sanitized raw HTML (<details> blocks), runnable code fences. */
export function Markdown({ content, onRun }: Props) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => {
            const child = children as { props?: { className?: string; children?: ReactNode } } | undefined;
            const code = textOf(child?.props?.children).replace(/\n$/, "");
            const runnable = Boolean(onRun) && isRunnableLanguage(child?.props?.className);
            return (
              <div className="codeblock">
                <pre>{children}</pre>
                {runnable ? (
                  <button className="codeblock-run" type="button" onClick={() => onRun?.(code)} title="Run in terminal">
                    ▶ run
                  </button>
                ) : null}
              </div>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
