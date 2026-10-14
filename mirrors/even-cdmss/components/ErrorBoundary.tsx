'use client';

import { Component, ReactNode } from 'react';

type Props = { children: ReactNode; label?: string };
type State = { err: Error | null; info: string | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null, info: null };

  static getDerivedStateFromError(err: Error): State {
    return { err, info: null };
  }

  componentDidCatch(err: Error, info: { componentStack?: string | null }) {
    this.setState({ err, info: info?.componentStack ?? null });
    // Also surface in console for browser devtools
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', this.props.label, err, info);
  }

  reset = () => this.setState({ err: null, info: null });

  render() {
    if (this.state.err) {
      return (
        <div className="mt-6 rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900">
          <div className="font-semibold">
            {this.props.label || 'Component'} crashed
          </div>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px]">
            {String(this.state.err?.message || this.state.err)}
          </pre>
          {this.state.info && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide">Component stack</summary>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">
                {this.state.info}
              </pre>
            </details>
          )}
          <button onClick={this.reset} className="mt-3 rounded bg-rose-600 px-3 py-1 text-xs font-medium text-white hover:bg-rose-700">
            Reset
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
