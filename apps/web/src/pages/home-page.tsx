import { Link } from 'react-router-dom';

export const HomePage = () => (
  <div className="page home-page">
    <section className="hero">
      <p className="eyebrow">Creator-led drops, exact odds</p>
      <h1>Discover the next drop before it disappears.</h1>
      <p className="hero-copy">
        Earn Drops from your favorite creators, see the odds, and reveal your rewards.
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
        <h2 id="principles-heading">Know what each Drop can reveal.</h2>
      </div>
      <ul>
        <li>Reward chances are shown before you open.</li>
        <li>Your available Drops come from earned entries.</li>
        <li>Each result is selected and recorded before the reveal.</li>
      </ul>
    </section>
  </div>
);
