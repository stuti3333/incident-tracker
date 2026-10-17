import { useEffect, useMemo, useRef, useState } from 'react';
import Safe from '../components/Safe.jsx';
import ColorBends from '../components/ColorBends.jsx';

const HOT = ['#ff5c3d', '#ffb020', '#ff2e63'];
const COOL = ['#4f8bff', '#22d3ee', '#8a5cff'];
const toRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mixHex = (a, b, t) => {
  const A = toRgb(a),
    B = toRgb(b);
  return (
    '#' +
    A.map((c, i) =>
      Math.round(c + (B[i] - c) * t)
        .toString(16)
        .padStart(2, '0'),
    ).join('')
  );
};

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

const BEATS = [
  {
    title: 'Production breaks.',
    body: 'An alert fires or someone reports it. Enter when it actually started, even if you are logging it late, and the timeline puts it in the right place.',
  },
  {
    title: 'Check what changed first.',
    body: 'Deploys from the 48 hours before onset are scored on recency, same service, production, failure status and past incidents. Each score lists its reasons.',
  },
  {
    title: 'Link it, then close it out.',
    body: 'You confirm the suspect and move the status along. Next time the same failure shows up, the history is already attached.',
  },
];

export default function Story() {
  const ref = useRef(null);
  const [step, setStep] = useState(0);

  useEffect(() => {
    let raf = 0;
    const read = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const span = Math.max(1, r.height - window.innerHeight);
      const p = clamp(-r.top / span);
      setStep(Math.round(p * 40));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  const p = step / 40;
  const calm = smooth(0.3, 0.8, p);
  const beat = p < 0.34 ? 0 : p < 0.68 ? 1 : 2;
  const colors = useMemo(
    () => HOT.map((h, i) => mixHex(h, COOL[i], calm)),
    [step],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section
      className="story intro-dark"
      id="story"
      ref={ref}
      aria-label="How an incident is handled"
    >
      <div className="story__pin">
        <div className="story__ticks" aria-hidden="true">
          {BEATS.map((_, i) => (
            <span
              key={i}
              className="story__tick"
              data-on={i === beat ? '' : undefined}
            />
          ))}
        </div>
        <div className="story__bg" aria-hidden="true">
          <Safe>
            <ColorBends
              colors={colors}
              rotation={90 + calm * 50}
              speed={0.2}
              scale={1}
              frequency={1}
              warpStrength={1}
              mouseInfluence={1}
              parallax={0.5}
              noise={0.15}
              iterations={1}
              intensity={1.5}
              bandWidth={6}
              transparent
            />
          </Safe>
        </div>
        <div className="story__copy">
          {BEATS.map((b, i) => (
            <article
              key={b.title}
              className="story__beat"
              data-on={i === beat ? '' : undefined}
              aria-hidden={i === beat ? undefined : true}
            >
              <h2>{b.title}</h2>
              <p>{b.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
