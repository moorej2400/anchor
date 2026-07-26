/**
 * Last-resort render guard. A throw anywhere in the tree would otherwise leave
 * React's root empty — a blank window with no explanation. This keeps the app's
 * surface on screen and shows what failed.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surfaced in the webview console / `tauri dev` output for diagnosis.
    console.error("Anchor render error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: 40,
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 14,
            background: "linear-gradient(135deg, #8a3fd0, #d6417a)",
            boxShadow: "0 8px 30px rgba(214,65,122,.35)",
            opacity: 0.85,
          }}
        />
        <div style={{ fontSize: 15, fontWeight: 600 }}>Anchor hit an unexpected error</div>
        <div
          style={{
            fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
            fontSize: 11.5,
            color: "#f0757f",
            maxWidth: 560,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {error.message || String(error)}
        </div>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          style={{
            marginTop: 6,
            padding: "8px 14px",
            borderRadius: 9,
            border: "1px solid rgba(255,255,255,.12)",
            background: "rgba(255,255,255,.04)",
            color: "rgba(255,255,255,.8)",
            fontSize: 12.5,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}
