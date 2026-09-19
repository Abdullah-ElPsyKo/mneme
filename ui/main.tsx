import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { isDesktop } from './desktopBridge';
import { DesktopBootstrap, DesktopCapture, DesktopHost } from './Desktop';
import './styles.css';
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div className="fatal">
        <h1>The view could not be displayed.</h1>
        <p>
          Your saved memory is on disk. Reload to reconnect to{' '}
          {isDesktop ? 'your brain' : 'the local service'}.
        </p>
        <button onClick={() => location.reload()}>Reload application</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    {isDesktop && new URLSearchParams(location.search).get('desktop') === 'setup' ? (
      <DesktopBootstrap />
    ) : isDesktop && new URLSearchParams(location.search).get('window') === 'capture' ? (
      <DesktopCapture />
    ) : (
      <>
        <App />
        {isDesktop && <DesktopHost />}
      </>
    )}
  </ErrorBoundary>,
);
