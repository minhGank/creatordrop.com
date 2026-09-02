import { CreatorDropApiError } from '../api/client.js';

export const LoadingState = ({ label = 'Loading' }: { readonly label?: string }) => (
  <div className="state-card" role="status" aria-live="polite">
    <span className="loading-mark" aria-hidden="true" />
    <p>{label}…</p>
  </div>
);

export const EmptyState = ({
  description,
  title,
}: {
  readonly description: string;
  readonly title: string;
}) => (
  <section className="state-card">
    <h2>{title}</h2>
    <p>{description}</p>
  </section>
);

const errorCopy = (error: Error): { readonly description: string; readonly title: string } => {
  if (error instanceof CreatorDropApiError) {
    if (error.status === 404) {
      return {
        description:
          'This public catalog item may be unavailable, paused, archived, or unpublished.',
        title: 'Not found',
      };
    }
    if (error.status === 401) {
      return { description: 'Your session has expired. Sign in again.', title: 'Session expired' };
    }
    if (error.status === 403) {
      return { description: 'You do not have access to this resource.', title: 'Access denied' };
    }
  }
  return { description: error.message, title: 'Something went wrong' };
};

export const ErrorState = ({
  error,
  onRetry,
}: {
  readonly error: Error;
  readonly onRetry?: () => void;
}) => {
  const copy = errorCopy(error);
  return (
    <section className="state-card error-state" role="alert">
      <p className="eyebrow">Request failed</p>
      <h1>{copy.title}</h1>
      <p>{copy.description}</p>
      {onRetry === undefined ? null : (
        <button className="button secondary" type="button" onClick={onRetry}>
          Try again
        </button>
      )}
    </section>
  );
};
