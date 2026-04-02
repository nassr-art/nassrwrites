/* ============================================================
   NASSR WRITES — Shared Components v2
   ============================================================ */

const NAV_LINKS = [
  { href: '/about',      label: 'About',      key: 'about'      },
  { href: '/writing',    label: 'Writing',    key: 'writing'    },
  { href: '/management', label: 'Management', key: 'management' },
  { href: '/events',     label: 'Events',     key: 'events'     },
  { href: '/contact',    label: 'Contact',    key: 'contact'    },
];

// ─── Reading time calculator ───────────────────────────────────
function readingTime(text) {
  return Math.max(1, Math.ceil((text || '').split(/\s+/).filter(Boolean).length / 200));
}

// ─── Current page detection ─────────────────────────────────────
function getCurrentPage() {
  const p = window.location.pathname.replace(/\/$/, '');
  if (!p || p === '/index.html') return 'home';
  return NAV_LINKS.find(l => p.startsWith(l.href))?.key || 'home';
}

// ─── Navigation ────────────────────────────────────────────────
function renderNav(content) {
  const current = getCurrentPage();
  const nav = document.getElementById('navbar');
  nav.innerHTML = `
    <div class="nav-inner">
      <a href="/" class="logo">${content.site.title.split(' ')[0]}</a>
      <ul class="nav-links">
        ${NAV_LINKS.map(l => `
          <li><a href="${l.href}"${current === l.key ? ' class="active"' : ''}>${l.label}</a></li>
        `).join('')}
      </ul>
      <button class="mobile-menu-btn" aria-label="Open menu" aria-expanded="false" aria-controls="mobileMenuOverlay">
        <span></span><span></span>
      </button>
    </div>`;

  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 50);
  }, { passive: true });

  _initMobileMenu(content, current);
}

function _initMobileMenu(content, current) {
  const stale = document.getElementById('mobileMenuOverlay');
  if (stale) stale.remove();

  const overlay = document.createElement('div');
  overlay.id = 'mobileMenuOverlay';
  overlay.className = 'mobile-menu-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Navigation menu');
  overlay.innerHTML = `
    <nav class="mobile-menu-nav" aria-label="Mobile navigation">
      <ul>
        ${NAV_LINKS.map(l => `
          <li><a href="${l.href}"${current === l.key ? ' class="active"' : ''}>${l.label}</a></li>
        `).join('')}
      </ul>
    </nav>
    <div class="mobile-menu-footer">
      ${content.site?.email ? `<a href="mailto:${content.site.email}" class="mobile-menu-email">${content.site.email}</a>` : ''}
    </div>`;
  document.body.appendChild(overlay);

  const btn = document.querySelector('.mobile-menu-btn');
  let savedScrollY = 0;

  function openMenu() {
    savedScrollY = window.scrollY;
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-label', 'Close menu');
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.style.position = 'fixed';
    document.body.style.top = `-${savedScrollY}px`;
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';
  }

  function closeMenu() {
    btn.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Open menu');
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.width = '';
    document.body.style.overflow = '';
    window.scrollTo(0, savedScrollY);
  }

  btn.addEventListener('click', () => {
    overlay.classList.contains('open') ? closeMenu() : openMenu();
  });
  overlay.querySelectorAll('a').forEach(a => a.addEventListener('click', closeMenu));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeMenu();
  });
  overlay.addEventListener('click', e => { if (e.target === overlay) closeMenu(); });
}

// ─── Footer ────────────────────────────────────────────────────
function renderFooter(content) {
  document.getElementById('footer').innerHTML = `
    <div class="footer-newsletter">
      <p class="footer-nl-tagline">Occasional letters on culture<br>and creative practice.</p>
      <form class="footer-nl-form nl-form" novalidate>
        <div class="nl-input-row">
          <input type="email" placeholder="Your email address" autocomplete="email" required>
          <button type="submit">Subscribe</button>
        </div>
        <p class="nl-message footer-nl-message"></p>
      </form>
    </div>
    <div class="footer-inner">
      <p class="footer-text">&copy; ${new Date().getFullYear()} ${content.site.title}. All rights reserved.</p>
      <div class="footer-links">
        <a href="/subscribe">Newsletter</a>
        <a href="https://${content.site.domain}" target="_blank" rel="noopener">${content.site.domain}</a>
      </div>
    </div>`;
}

// ─── Newsletter: Mailchimp JSONP ───────────────────────────────
function submitToMailchimp(actionUrl, email, name, onResult) {
  const cbName = '_mc' + Date.now();
  const params = new URLSearchParams({ EMAIL: email });
  if (name) params.set('FNAME', name);
  params.set('c', cbName);
  const endpoint = actionUrl.replace('/post?', '/post-json?') + '&' + params.toString();

  let settled = false;
  const settle = (data) => {
    if (settled) return;
    settled = true;
    delete window[cbName];
    if (script.parentNode) script.parentNode.removeChild(script);
    onResult(data);
  };

  window[cbName] = settle;
  const script = document.createElement('script');
  script.src = endpoint;
  script.onerror = () => settle({ result: 'error', msg: 'Network error. Please try again.' });
  document.body.appendChild(script);
  setTimeout(() => settle({ result: 'error', msg: 'Request timed out. Please try again.' }), 10000);
}

async function submitLocal(email, name) {
  const res = await fetch('/api/newsletter/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name })
  });
  const data = await res.json();
  return { result: res.ok ? 'success' : 'error', msg: data.message || data.error || '' };
}

function bindNewsletterForm(form, mailchimpUrl) {
  if (!form) return;
  form.addEventListener('submit', async function(e) {
    e.preventDefault();
    const emailInput = form.querySelector('[type="email"]');
    const nameInput  = form.querySelector('[data-nl-name]');
    const submitBtn  = form.querySelector('[type="submit"]');
    const msgEl      = form.querySelector('.nl-message');

    const email = emailInput?.value.trim() || '';
    const name  = nameInput?.value.trim()  || '';

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (msgEl) { msgEl.className = 'nl-message error'; msgEl.textContent = 'Please enter a valid email address.'; }
      return;
    }

    if (submitBtn) { submitBtn.disabled = true; submitBtn._orig = submitBtn.textContent; submitBtn.textContent = '…'; }
    if (msgEl) { msgEl.className = 'nl-message'; msgEl.textContent = ''; }

    const onResult = (data) => {
      const ok = data.result === 'success';
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = submitBtn._orig || 'Subscribe'; }
      if (msgEl) {
        msgEl.className = 'nl-message ' + (ok ? 'success' : 'error');
        const clean = (data.msg || '').replace(/<[^>]*>/g, '').trim();
        msgEl.textContent = clean || (ok ? "You're subscribed. Thank you." : 'Something went wrong.');
      }
      if (ok) form.reset();
    };

    if (mailchimpUrl) {
      submitToMailchimp(mailchimpUrl, email, name, onResult);
    } else {
      try { onResult(await submitLocal(email, name)); }
      catch { onResult({ result: 'error', msg: 'Could not connect. Please try again.' }); }
    }
  });
}

// ─── Fade-in with stagger ──────────────────────────────────────
function initFadeAnimations() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.08 });

  // Add staggered delay to grid children
  document.querySelectorAll('.practices-grid, .services-grid, .events-list').forEach(grid => {
    Array.from(grid.children).forEach((child, i) => {
      if (!child.classList.contains('fade-in')) {
        child.classList.add('fade-in');
        if (i > 0) child.dataset.delay = Math.min(i, 5).toString();
      }
    });
  });

  document.querySelectorAll('.fade-in').forEach(el => observer.observe(el));
}

// ─── Back-to-top button ─────────────────────────────────────────
function initBackToTop() {
  const btn = document.createElement('button');
  btn.id = 'backToTop';
  btn.setAttribute('aria-label', 'Back to top');
  btn.textContent = '↑';
  document.body.appendChild(btn);

  window.addEventListener('scroll', () => {
    btn.classList.toggle('visible', window.scrollY > 400);
  }, { passive: true });

  btn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// ─── Reading progress bar ──────────────────────────────────────
function initReadingProgress() {
  const articleBody = document.querySelector('.article-body');
  if (!articleBody) return;

  const bar = document.createElement('div');
  bar.id = 'readingProgress';
  document.body.prepend(bar);

  window.addEventListener('scroll', () => {
    const total = document.documentElement.scrollHeight - window.innerHeight;
    const pct = total > 0 ? (window.scrollY / total) * 100 : 0;
    bar.style.width = pct.toFixed(1) + '%';
  }, { passive: true });
}

// ─── Copy link button ──────────────────────────────────────────
function initCopyLink() {
  const btn = document.querySelector('.copy-link-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    } catch {
      btn.textContent = window.location.href;
    }
  });
}

// ─── Page initialiser ──────────────────────────────────────────
async function initPage(renderContent) {
  try {
    const res     = await fetch('/api/content');
    const content = await res.json();
    const mcUrl   = content.site?.mailchimpUrl || '';

    renderNav(content);
    renderContent(content);
    renderFooter(content);
    initFadeAnimations();
    initBackToTop();
    initReadingProgress();
    initCopyLink();

    document.querySelectorAll('form.nl-form').forEach(f => bindNewsletterForm(f, mcUrl));
  } catch (err) {
    console.error('Failed to load content:', err);
  }
}
