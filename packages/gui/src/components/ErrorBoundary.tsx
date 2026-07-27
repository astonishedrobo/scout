import { Component, type ErrorInfo, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "./ui/Button";
import { PixelDazed } from "./PixelArt";

/**
 * Last line of defence: without one, a single render throw anywhere in the tree
 * unmounts everything and leaves a blank page with no explanation and no way
 * back.
 *
 * Deliberately a class component — `componentDidCatch` has no hook equivalent.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the component stack in the console: the message alone rarely says
    // which panel threw.
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-scout-canvas px-6 text-center">
        <PixelDazed size={44} />
        <div className="max-w-md space-y-1.5">
          <h1 className="text-body font-semibold text-scout-text">Something broke</h1>
          <p className="text-label leading-relaxed text-scout-muted">
            The interface hit an unexpected error. Your conversations are saved on the server —
            reloading should bring everything back.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="filled" surface="canvas" onClick={() => window.location.reload()}>
            <RefreshCw size={15} />
            Reload Scout
          </Button>
          <Button variant="ghost" surface="canvas" onClick={() => this.setState({ error: null })}>
            Try to continue
          </Button>
        </div>
        <pre className="max-w-full overflow-x-auto rounded-card border border-scout-hairline-faint bg-scout-code-bg px-3 py-2 text-left text-micro text-scout-muted">
          {error.message}
        </pre>
      </div>
    );
  }
}
