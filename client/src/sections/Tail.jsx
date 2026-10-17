import ColorBends from '../components/ColorBends.jsx';
import Safe from '../components/Safe.jsx';

const COOL = ['#4f8bff', '#22d3ee', '#8a5cff']; // where the story above ends

// One ColorBends layer behind everything below the story. It stays pinned to the
// screen while the content scrolls over it.
export default function Tail({ children }) {
  return (
    <div className="tail">
      <div className="tail__bg" aria-hidden="true">
        <Safe>
          <ColorBends
            colors={COOL}
            rotation={140}
            speed={0.15}
            scale={1}
            frequency={1}
            warpStrength={1}
            mouseInfluence={0.6}
            parallax={0.5}
            noise={0.15}
            iterations={1}
            intensity={1.3}
            bandWidth={6}
            transparent
          />
        </Safe>
      </div>
      <div className="tail__content">{children}</div>
    </div>
  );
}
