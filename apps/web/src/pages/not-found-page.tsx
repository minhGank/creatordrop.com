import { Link } from 'react-router-dom';

export const NotFoundPage = () => (
  <div className="page narrow-page">
    <section className="state-card">
      <p className="eyebrow">404</p>
      <h1>Page not found</h1>
      <p>The page may have moved, or the catalog item is no longer public.</p>
      <Link className="button primary" to="/creators">
        Browse creators
      </Link>
    </section>
  </div>
);
