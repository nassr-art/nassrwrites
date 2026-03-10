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
            <button class="mobile-menu-btn" aria-label="Menu">
                <span></span><span></span>
            </button>
        </div>`;

    window.addEventListener('scroll', () => {
        nav.classList.toggle('scrolled', window.scrollY > 50);
    });
}

function renderFooter(content) {
    document.getElementById('footer').innerHTML = `
        <div class="footer-inner">
            <p class="footer-text">© ${new Date().getFullYear()} ${content.site.title}. All rights reserved.</p>
            <div class="footer-links">
                <a href="https://${content.site.domain}">${content.site.domain}</a>
            </div>
        </div>`;
}

function initFadeAnimations() {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
    }, { threshold: 0.1 });
    document.querySelectorAll('.fade-in').forEach(el => observer.observe(el));
}

function initNewsletterForm() {
    const form = document.getElementById('newsletterForm');
    if (!form) return;
    form.addEventListener('submit', async function (e) {
        e.preventDefault();
        const btn = document.getElementById('nlSubmit');
        const msg = document.getElementById('nlMessage');
        btn.disabled = true;
        btn.textContent = 'Subscribing...';
        msg.className = 'newsletter-message';
        msg.textContent = '';
        try {
            const res = await fetch('/api/newsletter/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: document.getElementById('nlName').value.trim(),
                    email: document.getElementById('nlEmail').value.trim()
                })
            });
            const data = await res.json();
            msg.className = 'newsletter-message ' + (res.ok ? 'success' : 'error');
            msg.textContent = res.ok ? data.message : (data.error || 'Something went wrong.');
            if (res.ok) form.reset();
        } catch {
            msg.className = 'newsletter-message error';
            msg.textContent = 'Could not connect. Please try again.';
        } finally {
            btn.disabled = false;
            btn.textContent = 'Subscribe';
        }
    });
}

async function initPage(renderContent) {
    try {
        const res = await fetch('/api/content');
        const content = await res.json();
        renderNav(content);
        renderContent(content);
        renderFooter(content);
        initFadeAnimations();
        initNewsletterForm();
    } catch (err) {
        console.error('Failed to load content:', err);
    }
}
