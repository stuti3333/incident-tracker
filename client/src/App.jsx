import { useCallback, useEffect, useState } from 'react';
import Hero from './sections/Hero.jsx';
import Story from './sections/Story.jsx';
import Features from './sections/Features.jsx';
import GetStarted from './sections/GetStarted.jsx';
import Tail from './sections/Tail.jsx';
import Tracker from './tracker/Tracker.jsx';

const routeOf = () => (window.location.hash.startsWith('#/tracker') ? 'tracker' : 'home');

export default function App() {
  const [route, setRoute] = useState(routeOf);

  const navigate = useCallback(next => {
    setRoute(prev => {
      if (prev !== next) window.scrollTo(0, 0);
      return next;
    });
    try {
      window.history.replaceState(null, '', next === 'tracker' ? '#/tracker' : '#/');
    } catch {
      /* sandboxed frames may refuse; state above still switches the page */
    }
  }, []);

  // browser back/forward and typed hashes
  useEffect(() => {
    const onHash = () => setRoute(routeOf());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (route === 'tracker') return <Tracker onHome={() => navigate('home')} />;
  return (
    <>
      <Hero onStart={() => navigate('tracker')} />
      <Story />
      <Tail>
        <Features />
        <GetStarted onStart={() => navigate('tracker')} />
      </Tail>
    </>
  );
}
