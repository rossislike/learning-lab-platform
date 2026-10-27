import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Shows a message with a reload link instead of a blank page when a page
 * throws while rendering (a Convex query error, an unexpected gateway body).
 * Layout keys it by path, so navigating away clears the error.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[learning-lab] render error", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <section className="notice">
        <h1>Something went wrong</h1>
        <p className="muted">{error.message}</p>
        <p>
          <a href={window.location.href}>Reload this page</a> · <a href="/">Back to areas</a>
        </p>
      </section>
    );
  }
}
