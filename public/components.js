/* ============================================================
   NASSR WRITES — Shared Components v3 (Dark Editorial)
   ============================================================ */

const NAV_LINKS = [
  { href: '/about',      label: 'About',      key: 'about'      },
  { href: '/writing',    label: 'Writing',    key: 'writing'    },
  { href: '/management', label: 'Management', key: 'management' },
  { href: '/events',     label: 'Events',     key: 'events'     },
  { href: '/contact',    label: 'Contact',    key: 'contact'    },
];

// ─── Reading time ──────────────────────────────────────────────
function readingTime(text) {
  return Math.max(1, Math.ceil((text || '').split(/\s+/).filter(Boolean).length / 200));
}

// ─── Current page detection ────────────────────────────────────
function getCurrentPage() {
  const p = window.location.pathname.replace(/\/$/, '');
  if (!p || p === '/index.html') return 'home';
  return NAV_LINKS.find(l => p.startsWith(l.href))?.key || 'home';
}

// ─── Logo mark ─────────────────────────────────────────────────
function brandWord(content) {
  return (content?.site?.title || 'Nassr').split(' ')[0];
}

// ─── Navigation ────────────────────────────────────────────────
function renderNav(content) {
  const current = getCurrentPage();
  const nav = document.getElementById('navbar');
  if (!nav) return;

  nav.innerHTML = `
    <div class="nav-inner">
      <a href="/" class="logo" aria-label="${content.site.title} — home">${brandWord(content)}</a>
      <ul class="nav-links">
        ${NAV_LINKS.map(l => `
          <li><a href="${l.href}"${current === l.key ? ' class="active" aria-current="page"' : ''}>${l.label}</a></li>
        `).join('')}
      </ul>
      <button class="mobile-menu-btn" aria-label="Open menu" aria-expanded="false" aria-controls="mobileMenuOverlay">
        <span></span><span></span>
      </button>
    </div>`;

  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 24);
  }, { passive: true });

  _initMobileMenu(content, current);
}

function _initMobileMenu(content, current) {
  const stale = document.getElementById('mobileMenuOverlay');
  if (stale) stale.remove();

  const overlay = document.createElement('div');
  overlay.id = 'mobileMenuOverlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Site navigation');
  overlay.innerHTML = `
    <ul>
      ${[{ href: '/', label: 'Home', key: 'home' }, ...NAV_LINKS].map(l => `
        <li><a href="${l.href}"${current === l.key ? ' class="active" aria-current="page"' : ''}>${l.label}</a></li>
      `).join('')}
    </ul>
    <div class="menu-footer">
      ${content.site?.email ? `<a href="mailto:${content.site.email}">${content.site.email}</a>` : ''}
    </div>`;
  document.body.appendChild(overlay);

  const btn = document.querySelector('.mobile-menu-btn');
  let savedScrollY = 0;

  function openMenu() {
    savedScrollY = window.scrollY;
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
}

// ─── Footer ────────────────────────────────────────────────────
function renderFooter(content) {
  const footer = document.getElementById('footer');
  if (!footer) return;
  const year = new Date().getFullYear();
  const site = content.site || {};
  footer.innerHTML = `
    <div class="footer-inner">
      <div class="footer-brand">
        <div class="footer-mark">${brandWord(content)}</div>
        <p>${site.description || ''}</p>
      </div>
      <div class="footer-col">
        <h4>Practice</h4>
        <ul>
          <li><a href="/writing">Writing</a></li>
          <li><a href="/management">Artist Management</a></li>
          <li><a href="/events">Events &amp; Curation</a></li>
          <li><a href="/about">About</a></li>
        </ul>
      </div>
      <div class="footer-col">
        <h4>Elsewhere</h4>
        <ul>
          <li><a href="/subscribe">Letters</a></li>
          <li><a href="/feed.xml">RSS</a></li>
          <li><a href="/contact">Contact</a></li>
          ${site.email ? `<li><a href="mailto:${site.email}">${site.email}</a></li>` : ''}
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <span>© ${year} ${site.title || 'Nassr Writes'}. All rights reserved.</span>
      <span>Set in Fraunces &amp; Newsreader.</span>
    </div>`;
}

// ─── Newsletter: Mailchimp JSONP / local fallback ──────────────
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

// ─── Fade-in animations with stagger ───────────────────────────
function initFadeAnimations() {
  // Opt-in: only hide content when JS is running. No-JS users see everything immediately.
  document.documentElement.classList.add('js-fade');

  // Stagger children of common collection containers
  document.querySelectorAll('.practices-list, .services-grid, .events-list, .writing-list, .selected-list, .archive-categories').forEach(grid => {
    Array.from(grid.children).forEach((child, i) => {
      if (!child.classList.contains('fade-in')) child.classList.add('fade-in');
      if (i > 0) child.style.setProperty('--fade-delay', `${Math.min(i * 80, 360)}ms`);
    });
  });

  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('.fade-in').forEach(el => el.classList.add('visible'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });

  document.querySelectorAll('.fade-in').forEach(el => observer.observe(el));

  // Safety net: if a user never scrolls (or a screenshot tool grabs the full page),
  // reveal any still-hidden fade-ins after 1.2s. The CSS transition still plays.
  setTimeout(() => {
    document.querySelectorAll('.fade-in:not(.visible)').forEach(el => el.classList.add('visible'));
  }, 1200);
}

// ─── Back to top ───────────────────────────────────────────────
function initBackToTop() {
  if (document.getElementById('backToTop')) return;
  const btn = document.createElement('button');
  btn.id = 'backToTop';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Back to top');
  btn.textContent = '↑';
  document.body.appendChild(btn);
  window.addEventListener('scroll', () => {
    btn.classList.toggle('visible', window.scrollY > 600);
  }, { passive: true });
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
}

// ─── Reading progress ──────────────────────────────────────────
function initReadingProgress() {
  const articleBody = document.querySelector('.article-body');
  if (!articleBody) return;
  let bar = document.getElementById('readingProgress');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'readingProgress';
    document.body.prepend(bar);
  }
  function update() {
    const rect = articleBody.getBoundingClientRect();
    const total = rect.height - window.innerHeight + rect.top + window.scrollY;
    const passed = Math.max(0, window.scrollY - (rect.top + window.scrollY - 80));
    const pct = total > 0 ? Math.min(100, (passed / total) * 100) : 0;
    bar.style.width = pct.toFixed(1) + '%';
  }
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();
}

// ─── Copy link button ──────────────────────────────────────────
function initCopyLink() {
  const btn = document.querySelector('.copy-link-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      const orig = btn.textContent;
      btn.textContent = 'Copied';
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
    if (typeof renderContent === 'function') renderContent(content);
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
