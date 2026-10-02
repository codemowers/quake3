export function createConnectionRecovery({identity, reconnect, onStatus, fetchIdentity = () =>
  fetch('/auth/me', {cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(5000)})}) {
  let active = false;
  let generation = 0;
  let timer;

  async function check(current) {
    try {
      const response = await fetchIdentity();
      if (!active || current !== generation) return;
      if (response.status === 401) {
        onStatus('login', 'Your session ended. Sign in to reconnect.');
      } else if (response.ok) {
        const refreshed = await response.json();
        if (!active || current !== generation) return;
        if (identity.authenticated && refreshed.subject !== identity.subject) {
          onStatus('login', 'Sign in with the same account to resume this game.');
        } else {
          onStatus('connecting', 'Reconnecting to the game…');
          reconnect();
        }
      } else {
        onStatus('connecting', 'Waiting for the gateway…');
      }
    } catch {
      if (active && current === generation) onStatus('connecting', 'Waiting for the gateway…');
    }
    if (active && current === generation) timer = setTimeout(() => void check(current), 3000);
  }

  function connected() {
    active = false;
    generation++;
    clearTimeout(timer);
    onStatus('connected', '');
  }

  return {
    disconnected() {
      if (active) return;
      active = true;
      onStatus('connecting', 'Connection lost. Reconnecting…');
      void check(++generation);
    },
    connected,
    close() {
      active = false;
      generation++;
      clearTimeout(timer);
    }
  };
}
