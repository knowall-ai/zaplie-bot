import React, { FunctionComponent, ReactNode, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import styles from './StatusPage.module.css';
import { ErrorKind } from '../utils/appErrors';

// One branded page for every "this did not work" state: the Not found page,
// the error boundary and the friendly failure states. The heading takes focus
// so a screen reader announces the change; no stack or internal detail is
// ever shown, only a short reference id to quote.
export const StatusPage: FunctionComponent<{
  code?: string;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  referenceId?: string;
  alert?: boolean;
}> = ({ code, title, children, actions, referenceId, alert = true }) => {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <main className={styles.page}>
      <section
        className={styles.card}
        role={alert ? 'alert' : undefined}
        aria-labelledby="status-title"
      >
        {code ? (
          <p className={styles.code} aria-hidden="true">
            {code}
          </p>
        ) : null}
        <h1
          id="status-title"
          className={styles.title}
          tabIndex={-1}
          ref={heading}
        >
          {title}
        </h1>
        <div className={styles.body}>{children}</div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
        {referenceId ? (
          <p className={styles.reference} data-testid="reference-id">
            Reference: <strong>{referenceId}</strong> (quote this if you contact
            support)
          </p>
        ) : null}
      </section>
    </main>
  );
};

const FeedLink = () => (
  <Link className={styles.secondary} to="/feed">
    Back to Feed
  </Link>
);

/** The portal's own 404: an unknown address inside Zaplie. */
export const NotFound: FunctionComponent = () => (
  <StatusPage
    code="404"
    title="Page not found"
    actions={<FeedLink />}
    alert={false}
  >
    <p>
      There is nothing at this address. It may have moved, or the link may be
      mistyped.
    </p>
  </StatusPage>
);

const COPY: Record<ErrorKind, { title: string; body: string }> = {
  'signed-out': {
    title: 'Please sign in again',
    body: 'Your session has ended. Sign in again to carry on where you were.',
  },
  'not-member': {
    title: 'Zaplie is not available for this account',
    body: 'This account is not a member of an organisation using Zaplie, or is a guest your organisation has not allowed in. Ask your Zaplie admin if you think it should be.',
  },
  forbidden: {
    title: 'Admins only',
    body: 'This part of Zaplie is for your organisation’s Zaplie admins. Ask one of them if you need a change here.',
  },
  'wallet-unreachable': {
    title: 'The wallet service is unreachable',
    body: 'Zaplie could not reach the wallet service just now, so balances and zaps are unavailable. Nothing was paid. Try again in a minute.',
  },
  'not-found': {
    title: 'Not found',
    body: 'What you were looking for is not there any more.',
  },
  unknown: {
    title: 'Something went wrong',
    body: 'Zaplie hit an unexpected problem. Try again; if it keeps happening, contact support with the reference below.',
  },
};

/** A friendly failure state with the action that fits it. */
export const ErrorState: FunctionComponent<{
  kind: ErrorKind;
  referenceId?: string;
  onRetry?: () => void;
}> = ({ kind, referenceId, onRetry }) => {
  const copy = COPY[kind];
  const actions = (
    <>
      {kind === 'signed-out' ? (
        <Link className={styles.primary} to="/login">
          Sign in
        </Link>
      ) : null}
      {kind !== 'signed-out' &&
      kind !== 'forbidden' &&
      kind !== 'not-member' ? (
        <button
          type="button"
          className={styles.primary}
          onClick={onRetry || (() => window.location.reload())}
        >
          Try again
        </button>
      ) : null}
      <FeedLink />
    </>
  );
  return (
    <StatusPage title={copy.title} actions={actions} referenceId={referenceId}>
      <p>{copy.body}</p>
    </StatusPage>
  );
};
