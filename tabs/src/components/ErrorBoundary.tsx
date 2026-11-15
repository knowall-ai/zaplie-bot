import React, { Component, ErrorInfo, ReactNode } from 'react';
import { ErrorState } from './StatusPage';
import {
  classifyError,
  ErrorKind,
  newReferenceId,
  reportClientError,
} from '../utils/appErrors';
import { logger } from '../utils/logger';

interface Props {
  children: ReactNode;
  // Changing it (e.g. the route) clears a caught error.
  resetKey?: string;
}

interface State {
  error: { kind: ErrorKind; referenceId: string } | null;
  resetKey?: string;
}

// React only catches render errors in a class component (there is no hook
// for it), so this is the one class in the portal. It shows the friendly
// error page with a reference id and reports that id to the backend log;
// the stack goes to the console only, never to the page.
class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return {
      error: { kind: classifyError(error), referenceId: newReferenceId() },
    };
  }

  static getDerivedStateFromProps(
    props: Props,
    state: State,
  ): Partial<State> | null {
    return props.resetKey !== state.resetKey
      ? { error: null, resetKey: props.resetKey }
      : null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const referenceId = this.state.error?.referenceId || newReferenceId();
    logger.error(
      `Zaplie portal error ${referenceId}`,
      error,
      info.componentStack,
    );
    reportClientError({
      referenceId,
      kind: 'render',
      route: typeof window !== 'undefined' ? window.location.pathname : '',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private retry = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <ErrorState
          kind={error.kind}
          referenceId={error.referenceId}
          onRetry={this.retry}
        />
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
