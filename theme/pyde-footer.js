// Pyde footer injection — appended to every page below the chapter content.
(function () {
  'use strict';

  function inject() {
    if (document.querySelector('.pyde-footer')) return;

    var footer = document.createElement('footer');
    footer.className = 'pyde-footer';
    footer.innerHTML = [
      '<div class="pyde-footer-inner">',
      '  <div class="pyde-footer-tagline">',
      '    <span class="pyde-footer-mark" aria-hidden="true"></span>',
      '    <span>Pyde — a fairer, future-proof Layer 1, designed for the next decade of crypto.</span>',
      '  </div>',
      '  <nav class="pyde-footer-links" aria-label="Pyde social links">',
      '    <a href="https://pyde.network" target="_blank" rel="noopener" title="pyde.network">',
      '      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
      '        <circle cx="12" cy="12" r="10"/>',
      '        <line x1="2" y1="12" x2="22" y2="12"/>',
      '        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
      '      </svg>',
      '      <span>pyde.network</span>',
      '    </a>',
      '    <a href="https://github.com/pyde-net" target="_blank" rel="noopener" title="github.com/pyde-net">',
      '      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">',
      '        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.335-1.756-1.335-1.756-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.4 3-.405 1.02.005 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>',
      '      </svg>',
      '      <span>GitHub</span>',
      '    </a>',
      '    <a href="https://x.com/pydenet" target="_blank" rel="noopener" title="@pydenet on X">',
      '      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">',
      '        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>',
      '      </svg>',
      '      <span>@pydenet</span>',
      '    </a>',
      '    <a href="https://t.me/pydenet" target="_blank" rel="noopener" title="Pyde on Telegram">',
      '      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">',
      '        <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/>',
      '      </svg>',
      '      <span>Telegram</span>',
      '    </a>',
      '    <a href="mailto:info@pyde.network" title="info@pyde.network">',
      '      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
      '        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>',
      '        <polyline points="22,6 12,13 2,6"/>',
      '      </svg>',
      '      <span>info@pyde.network</span>',
      '    </a>',
      '  </nav>',
      '  <div class="pyde-footer-copy">© Pyde Network</div>',
      '</div>'
    ].join('\n');

    var target = document.querySelector('main')
              || document.querySelector('.content')
              || document.querySelector('.page-wrapper');
    if (!target) return;

    if (target.tagName.toLowerCase() === 'main') {
      target.appendChild(footer);
    } else {
      target.appendChild(footer);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
