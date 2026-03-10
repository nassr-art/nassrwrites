const NAV_LINKS = [
    { href: '/about',      label: 'About',      key: 'about' },
    { href: '/writing',    label: 'Writing',    key: 'writing' },
    { href: '/management', label: 'Management', key: 'management' },
    { href: '/events',     label: 'Events',     key: 'events' },
    { href: '/contact',    label: 'Contact',    key: 'contact' },
];

function getCurrentPage() {
    const p = window.location.pathname.replace(/\/$/, '');
    if (!p || p === '/index.html') return 'home';
    return NAV_LINKS.find(l => p.startsWith(l.href))?.key || 'home';
}

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
    });

    _initMobileMenu(content, current);
}

function _initMobileMenu(content, current) {
    // Remove any stale overlay from a previous render
    const stale = document.getElementById('mobileMenuOverlay');
    if (stale) stale.remove();

    // Build overlay
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
        // Lock body scroll (iOS-safe)
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
        // Restore body scroll
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.width = '';
        document.body.style.overflow = '';
        window.scrollTo(0, savedScrollY);
    }

    // Toggle on hamburger tap
    btn.addEventListener('click', () => {
        overlay.classList.contains('open') ? closeMenu() : openMenu();
    });

    // Close when a nav link is tapped
    overlay.querySelectorAll('a').forEach(a => {
        a.addEventListener('click', closeMenu);
    });

    // Close on Escape key
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && overlay.classList.contains('open')) closeMenu();
    });

    // Close when tapping the overlay background (not a child element)
    overlay.addEventListener('click', e => {
        if (e.target === overlay) closeMenu();
    });
}

function renderFooter(content) {
    document.getElementById('footer').innerHTML = `
        <div class="footer-newsletter">
            <p class="footer-nl-tagline">Occasional letters on culture<br>and creative practice.</p>
            <form class="footer-nl-form nl-form" novalidate>
                <div class="footer-nl-field">
                    <input type="email" placeholder="Your email address" autocomplete="email" required>
                    <button type="submit">Subscribe</button>
                </div>
                <p class="nl-message footer-nl-message"></p>
            </form>
        </div>
        <div class="footer-inner">
            <p class="footer-text">© ${new Date().getFullYear()} ${content.site.title}. All rights reserved.</p>
            <div class="footer-links">
                <a href="/subscribe">Newsletter</a>
                <a href="https://${content.site.domain}">${content.site.domain}</a>
            </div>
        </div>`;
}

// ─── Mailchimp JSONP submission ───────────────────────────────────────────────

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

// ─── Generic newsletter form binder ──────────────────────────────────────────
// Works with any <form class="nl-form"> that contains:
//   - [type="email"]            required email input
//   - [data-nl-name]            optional name input
//   - [type="submit"]           submit button
//   - .nl-message               status message element

function bindNewsletterForm(form, mailchimpUrl) {
    if (!form) return;

    form.addEventListener('submit', async function (e) {
        e.preventDefault();

        const emailInput = form.querySelector('[type="email"]');
        const nameInput  = form.querySelector('[data-nl-name]');
        const submitBtn  = form.querySelector('[type="submit"]');
        const msgEl      = form.querySelector('.nl-message');

        const email = emailInput ? emailInput.value.trim() : '';
        const name  = nameInput  ? nameInput.value.trim()  : '';

        // Client-side validation
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            if (msgEl) {
                msgEl.className = 'nl-message error';
                msgEl.textContent = 'Please enter a valid email address.';
            }
            return;
        }

        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn._orig = submitBtn.textContent;
            submitBtn.textContent = '…';
        }
        if (msgEl) { msgEl.className = 'nl-message'; msgEl.textContent = ''; }

        const onResult = (data) => {
            const ok = data.result === 'success';
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = submitBtn._orig || 'Subscribe'; }
            if (msgEl) {
                msgEl.className = 'nl-message ' + (ok ? 'success' : 'error');
                // Mailchimp sometimes embeds HTML in msg — strip tags for safety
                const clean = (data.msg || '').replace(/<[^>]*>/g, '').trim();
                msgEl.textContent = clean || (ok ? 'You\'re subscribed. Thank you.' : 'Something went wrong.');
            }
            if (ok) form.reset();
        };

        if (mailchimpUrl) {
            submitToMailchimp(mailchimpUrl, email, name, onResult);
        } else {
            try {
                onResult(await submitLocal(email, name));
            } catch {
                onResult({ result: 'error', msg: 'Could not connect. Please try again.' });
            }
        }
    });
}

// ─── Fade-in on scroll ────────────────────────────────────────────────────────

function initFadeAnimations() {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
    }, { threshold: 0.1 });
    document.querySelectorAll('.fade-in').forEach(el => observer.observe(el));
}

// ─── Page initialiser ─────────────────────────────────────────────────────────

async function initPage(renderContent) {
    try {
        const res     = await fetch('/api/content');
        const content = await res.json();
        const mcUrl   = content.site?.mailchimpUrl || '';

        renderNav(content);
        renderContent(content);
        renderFooter(content);
        initFadeAnimations();

        // Bind every nl-form on the page (footer + any page-level forms)
        document.querySelectorAll('form.nl-form').forEach(f => bindNewsletterForm(f, mcUrl));
    } catch (err) {
        console.error('Failed to load content:', err);
    }
}
