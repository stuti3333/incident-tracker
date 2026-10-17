import SpecularButton from '../components/SpecularButton.jsx';

export default function GetStarted({ onStart }) {
  return (
    <section className="getstarted intro-dark" id="get-started">
      <h2>Set it up before the next outage.</h2>
      <p>Create a project, record your deploys, and the next incident starts with a ranked list of suspects.</p>
      <SpecularButton size="lg" radius={18} onClick={onStart}>
        Get started
      </SpecularButton>
    </section>
  );
}
