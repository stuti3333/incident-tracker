import { Component } from 'react';

// If WebGL is unavailable the page still reads fine without the backdrop.
export default class Safe extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
