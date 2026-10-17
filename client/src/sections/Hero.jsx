import FaultyTerminal from '../components/FaultyTerminal.jsx';
import TechText from '../components/TechText.jsx';
import SpecularButton from '../components/SpecularButton.jsx';

const go = id => e => {
  e.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

export default function Hero({ onStart }) {
  return (
    <section className="hero intro-dark" id="top">
      <div className="hero__bg" aria-hidden="true">
        <FaultyTerminal
          tint="#ff6a3d"
          glyphs="blocks"
          scale={1.5}
          digitSize={1.2}
          timeScale={0.5}
          brightness={0.7}
          glow={0.5}
          persistence={0.5}
          mouseStrength={0.5}
          mouseGlow={0.6}
          curvature={0.1}
          vignette={0.4}
          clickEffect="glitch"
        />
      </div>
      <div className="hero__inner">
        <div className="hero__word">
          <TechText
            text="Incident Tracker"
            fontFamily="'Bricolage Grotesque', 'Segoe UI', system-ui, sans-serif"
            fontWeight={700}
            fontSize={170}
            reveal="letter"
            intro="metrics"
            introDuration={2.4}
            guides
            specks={15}
            clickKick
          />
        </div>
        <p className="hero__lede">
          When production breaks: what changed, which deploy is the likely cause, and has this happened before?
        </p>
        <div className="hero__actions">
          <SpecularButton size="lg" radius={18} onClick={onStart}>
            Open the tracker
          </SpecularButton>
          <a className="hero__more" href="#story" onClick={go('story')}>
            See how it finds the cause
          </a>
        </div>
      </div>
    </section>
  );
}
