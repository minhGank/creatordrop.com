import { Link } from 'react-router-dom';

export const HomePage = () => (
  <div className="page home-page">
    <section className="hero">
      <p className="eyebrow">Creator-led drops, exact odds</p>
      <h1>Discover the next drop before it disappears.</h1>
      <p className="hero-copy">
        Browse immutable published reward configurations and understand every weight before you
        participate.
      </p>
      <div className="hero-actions">
        <Link className="button primary" to="/creators">
          Explore creators
        </Link>
        <Link className="button secondary" to="/auth">
          Sign in
        </Link>
      </div>
    </section>
    <section className="principles" aria-labelledby="principles-heading">
      <div>
        <p className="eyebrow">Built in public</p>
        <h2 id="principles-heading">A catalog you can inspect.</h2>
      </div>
      <ul>
        <li>Published reward weights stay tied to their immutable version.</li>
        <li>Money is displayed from integer minor units.</li>
        <li>Unavailable or legacy configurations are never presented as actionable.</li>
      </ul>
    </section>
  </div>
);
