import { useRef } from 'react';
import TechText from '../components/TechText.jsx';

const FONT = "'Bricolage Grotesque', 'Segoe UI', system-ui, sans-serif";

// Glass card with a cursor-following sheen, a gentle tilt, a one-off light sweep
// on mount and a soft reflection underneath. Remount it (key) to replay the entrance.
export default function ReflectCard({ title, children }) {
  const ref = useRef(null);
  const move = e => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    el.style.setProperty('--mx', `${px * 100}%`);
    el.style.setProperty('--my', `${py * 100}%`);
    el.style.setProperty('--rx', `${((px - 0.5) * 3).toFixed(2)}deg`);
    el.style.setProperty('--ry', `${(-(py - 0.5) * 2.4).toFixed(2)}deg`);
  };
  const leave = () => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
  };
  return (
    <div className="rcard" ref={ref} onPointerMove={move} onPointerLeave={leave}>
      <div className="rcard__glass" aria-hidden="true" />
      <div className="rcard__title">
        <h2 className="sr-only">{title}</h2>
        <div className="rcard__type" aria-hidden="true">
          <TechText
            text={title}
            align="left"
            fontFamily={FONT}
            fontWeight={700}
            fontSize={64}
            reveal="letter"
            intro="metrics"
            introDuration={1.5}
            guides
            specks={10}
            clickKick
          />
        </div>
      </div>
      <div className="rcard__body">{children}</div>
      <div className="rcard__reflection" aria-hidden="true" />
    </div>
  );
}
