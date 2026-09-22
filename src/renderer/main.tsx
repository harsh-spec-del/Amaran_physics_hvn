import React from 'react';
import ReactDOM from 'react-dom/client';
import AppShell from './AppShell';

// Design-system fonts, self-hosted and bundled at build time (@fontsource).
// Previously loaded from fonts.googleapis.com at runtime, which silently
// dropped the whole typography system on an air-gapped machine — the exact
// deployment target this product is built for (see intend.md / README).
import '@fontsource/bebas-neue';
import '@fontsource/montserrat/600.css';
import '@fontsource/open-sans/400.css';
import '@fontsource/open-sans/600.css';
import '@fontsource/public-sans/500.css';
import '@fontsource/roboto-condensed/400.css';
import '@fontsource/roboto-condensed/700.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <AppShell />
  </React.StrictMode>,
);
