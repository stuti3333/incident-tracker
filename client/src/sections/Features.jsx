import MagicBento from '../components/MagicBento.jsx';
import './features.css';

const Suspects = () => (
  <div className="fv-suspects magic-bento__well">
    {[
      { score: 86, version: 'v2.4.1', why: 'api, production, failed, 23 min before onset' },
      { score: 41, version: 'v2.4.0', why: 'api, production, succeeded, 5 h before onset' },
      { score: 12, version: 'v2.3.9', why: 'worker, staging, succeeded, 31 h before onset' }
    ].map(r => (
      <div className="fv-suspect magic-bento__tile" key={r.version}>
        <b className="fv-score">{r.score}</b>
        <span className="fv-suspect-copy">
          <span className="fv-suspect-version">{r.version}</span>
          <span className="fv-suspect-why">{r.why}</span>
        </span>
      </div>
    ))}
  </div>
);

const Merged = () => (
  <div className="fv-merged">
    <b>×3</b>
    <span>reports, one incident</span>
  </div>
);

const Live = () => (
  <div className="fv-live">
    <i />
    <span>Every open tab updates</span>
  </div>
);

const Late = () => (
  <div className="fv-late magic-bento__well">
    <div className="fv-late-line">
      <span className="fv-late-dot" />
      <span className="fv-late-dot fv-late-dot--flag" />
      <span className="fv-late-dot" />
    </div>
    <div className="fv-late-labels">
      <span>Deploy v2.4.1</span>
      <span>Onset, logged 40 min late</span>
      <span>Rollback</span>
    </div>
  </div>
);

const Conflict = () => (
  <div className="fv-conflict">
    <div className="fv-conflict-row magic-bento__tile">
      <span>Save with version 7</span>
      <b>409</b>
    </div>
    <div className="fv-conflict-row magic-bento__tile">
      <span>Showing version 8</span>
      <b>ok</b>
    </div>
  </div>
);

const Roles = () => (
  <div className="fv-roles">
    {['viewer', 'developer', 'admin'].map((r, i) => (
      <span key={r} className="fv-role magic-bento__tile" data-level={i}>
        {r}
      </span>
    ))}
  </div>
);

const ITEMS = [
  {
    title: 'Ranked suspect deploys',
    description: 'A heuristic ranking with reasons attached. You confirm the cause, it never decides for you.',
    visual: <Suspects />,
    colSpan: 2,
    rowSpan: 2
  },
  { title: 'Duplicates merge', description: 'Repeat reports add to the open incident.', visual: <Merged /> },
  { title: 'Live', description: 'Server-sent events, no refresh.', visual: <Live /> },
  {
    title: 'Late reports land in order',
    description: 'The timeline sorts by when it happened, not when it was logged.',
    visual: <Late />,
    colSpan: 2
  },
  {
    title: 'Edits never overwrite',
    description: 'A stale save gets a 409 and the current state. Comments and links only append.',
    visual: <Conflict />,
    colSpan: 2
  },
  {
    title: 'Three roles',
    description: 'Viewers read, developers write, admins see the audit log.',
    visual: <Roles />,
    colSpan: 2
  }
];

export default function Features() {
  return (
    <section className="features intro-dark" id="features">
      <div className="features__head">
        <h2>Built for the messy part of an outage</h2>
        <p>Webhooks retry, reports arrive late and two people edit the same incident. These are handled so the record stays right.</p>
      </div>
      <div className="features__grid">
        <MagicBento items={ITEMS} columns={4} rowHeight={220} gap={12} radius={20} glowColor="#4f8bff" enableBorderGlow enableSpotlight spotlightRadius={300} clickEffect />
      </div>
    </section>
  );
}
