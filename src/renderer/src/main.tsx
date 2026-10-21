import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { I18nProvider } from './i18n';
import { applyStoredTheme } from './theme';
import { AndroidWindowPage } from './pages/AndroidWindow';
import './styles.css';

// Apply the saved theme BEFORE the first render. Doing it in an effect would paint one frame
// in the default theme first, which reads as a flash for anyone who chose light.
applyStoredTheme();

// Standalone per-profile Android window: the Tauri shell opens one OS window per profile at
// `#/android-window?profile=<id>`. Hash-routed so the backend's static server needs no new
// route — the SPA fallback already serves index.html for unknown paths.
function androidWindowProfile(): string | null {
  try {
    const hash = window.location.hash || '';
    const q = hash.indexOf('?');
    if (!hash.startsWith('#/android-window')) return null;
    const params = new URLSearchParams(q >= 0 ? hash.slice(q + 1) : '');
    const id = (params.get('profile') || '').trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <I18nProvider>
        {(() => {
          const androidProfile = androidWindowProfile();
          return androidProfile ? <AndroidWindowPage profileId={androidProfile} /> : <App />;
        })()}
      </I18nProvider>
    </StrictMode>
  );
}
