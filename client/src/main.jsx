import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// No <StrictMode>: FaultyTerminal and SpecularButton release their WebGL context
// on cleanup, and StrictMode's dev-only double mount would hand them a lost one.
createRoot(document.getElementById('root')).render(<App />);
