require('dotenv').config();

const express         = require('express');
const cors            = require('cors');
const session         = require('express-session');
const FileStore       = require('session-file-store')(session);
const bcrypt          = require('bcryptjs');
const fs              = require('fs');
const path            = require('path');
const crypto          = require('crypto');
const helmet          = require('helmet');
const morgan          = require('morgan');
const rateLimit       = require('express-rate-limit');
const validator       = require('validator');
const { marked }      = require('marked');
const createDOMPurify = require('dompurify');
const { JSDOM }       = require('jsdom');
const multer          = require('multer');

// ─── App ──────────────────────────────────────────────────────────────────────
const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS, 10) || 12;

// ─── Validate production secrets ─────────────────────────────────────────────
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET && process.env.NODE_ENV === 'production') {
    console.error('FATAL: SESSION_SECRET env var must be set in production');
    process.exit(1);
}

// ─── Utility functions ────────────────────────────────────────────────────────

function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#x27;');
}

function slugify(text) {
    return String(text)
        .toLowerCase().trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/[\s_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 100);
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
    });
}

// ─── Markdown rendering (server-side) ─────────────────────────────────────────
// marked parses → DOMPurify strips any XSS from the resulting HTML.
// This same pipeline is used for both preview responses and published content.
const purifyWindow = new JSDOM('').window;
const DOMPurify = createDOMPurify(purifyWindow);
marked.setOptions({ gfm: true, breaks: true });

function renderMarkdown(text) {
    if (!text) return '';
    const raw = marked.parse(String(text));
    return DOMPurify.sanitize(raw, {
        ALLOWED_TAGS: ['h1','h2','h3','h4','h5','h6','p','a','ul','ol','li',
                       'blockquote','code','pre','strong','em','del','hr','br',
                       'img','table','thead','tbody','tr','th','td'],
        ALLOWED_ATTR: ['href','src','alt','title','class'],
        ALLOW_DATA_ATTR: false,
    });
}

// ─── Data paths ───────────────────────────────────────────────────────────────
const DATA_DIR    = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const SEED_DIR    = path.join(__dirname, 'data'); // committed empty seeds
const SESSION_DIR = path.join(DATA_DIR, 'sessions');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

const DATA_FILES = {
    content:  path.join(DATA_DIR, 'content.json'),
    projects: path.join(DATA_DIR, 'projects.json'),
    posts:    path.join(DATA_DIR, 'posts.json'),
};

// ─── Initialize data directories and seed files on first boot ─────────────────
;(function initDataDir() {
    fs.mkdirSync(DATA_DIR,    { recursive: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });

    for (const [key, destPath] of Object.entries(DATA_FILES)) {
        if (!fs.existsSync(destPath)) {
            const seedPath = path.join(SEED_DIR, `${key}.json`);
            if (fs.existsSync(seedPath)) {
                fs.copyFileSync(seedPath, destPath);
            } else {
                fs.writeFileSync(destPath, JSON.stringify({ list: [] }, null, 2));
            }
        }
    }
})();

// ─── Atomic, concurrent-safe JSON write queue (one queue per file) ─────────────
// Each file gets its own serialised promise chain.  Every write goes to a .tmp
// file first, then is renamed atomically — a crash can never leave a torn file.
const _queues = new Map();

async function readJson(filePath) {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw);
}

function writeJson(filePath, data) {
    if (!_queues.has(filePath)) _queues.set(filePath, Promise.resolve());
    const q = _queues.get(filePath).then(async () => {
        const tmp = `${filePath}.tmp.${Date.now()}`;
        try {
            await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
            await fs.promises.rename(tmp, filePath);
        } catch (err) {
            await fs.promises.unlink(tmp).catch(() => {});
            throw err;
        }
    });
    _queues.set(filePath, q);
    return q;
}

// Short-hands kept for existing route code
const readContent  = () => readJson(DATA_FILES.content);
const writeContent = (d) => writeJson(DATA_FILES.content, d);

// ─── Image upload (multer) ────────────────────────────────────────────────────
const ALLOWED_IMAGE_EXTS  = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif']);
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOADS_DIR),
        filename: (req, file, cb) => {
            // Unique name — never trust the original filename
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
        },
    }),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB hard cap
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        // Double-check both extension and MIME type
        if (ALLOWED_IMAGE_EXTS.has(ext) && file.mimetype.startsWith('image/')) {
            return cb(null, true);
        }
        cb(new Error('Only image files are allowed (jpg, png, gif, webp, avif)'));
    },
});

// ─── EJS view engine ──────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Helpers available in every EJS template without passing them each time
app.locals.escapeHtml    = escapeHtml;
app.locals.renderMarkdown = renderMarkdown;
app.locals.formatDate    = formatDate;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.set('trust proxy', 1);

app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
        directives: {
            defaultSrc:     ["'self'"],
            scriptSrc:      ["'self'", "'unsafe-inline'"],
            styleSrc:       ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc:        ["'self'", "https://fonts.gstatic.com"],
            imgSrc:         ["'self'", "data:", "blob:"],
            connectSrc:     ["'self'"],
            objectSrc:      ["'none'"],
            frameAncestors: ["'none'"],
            baseUri:        ["'self'"],
            formAction:     ["'self'"],
        },
    },
}));

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : ['http://localhost:3000'];

app.use(cors({
    origin: (origin, cb) => (!origin || ALLOWED_ORIGINS.includes(origin) ? cb(null, true) : cb(new Error('CORS: origin not allowed'))),
    credentials: true,
}));

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Serve public/ files, the admin SPA, and persistent uploads
app.use(express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Session
app.use(session({
    store: new FileStore({ path: SESSION_DIR, ttl: 86400, retries: 1, reapInterval: 3600 }),
    secret: SESSION_SECRET || 'dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    name: 'sid',
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000,
    },
}));

// ─── CSRF (double-submit cookie pattern) ──────────────────────────────────────
// A random token is minted into the session on every request, then mirrored as
// a JS-readable cookie (XSRF-TOKEN).  Mutating endpoints require the token back
// either as X-XSRF-Token header (for JSON API + fetch calls) or as the _csrf
// body field (for plain HTML form POSTs rendered by EJS).
app.use((req, res, next) => {
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    res.cookie('XSRF-TOKEN', req.session.csrfToken, {
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        httpOnly: false,
    });
    next();
});

function csrfCheck(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    // Accept token from header (fetch/XHR) OR hidden form field (HTML forms)
    const token = req.headers['x-xsrf-token'] || req.body?._csrf;
    if (!token || !req.session.csrfToken || token !== req.session.csrfToken) {
        // Return JSON for API calls, HTML for form submissions
        const wantsJson = req.headers.accept?.includes('application/json') || req.headers['content-type']?.includes('application/json');
        if (wantsJson) return res.status(403).json({ error: 'CSRF validation failed' });
        return res.status(403).send('<h1>403 — CSRF validation failed</h1>');
    }
    next();
}

// ─── Auth middlewares ─────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
    if (req.session?.authenticated) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// For EJS-rendered admin pages: redirect to the admin SPA login instead of 401
function requireAuthPage(req, res, next) {
    if (req.session?.authenticated) return next();
    res.redirect('/admin');
}

// ─── Rate limiter on login ────────────────────────────────────────────────────
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Too many login attempts. Try again in 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
});

// ─── Admin action logger ──────────────────────────────────────────────────────
function logAction(req, action) {
    const user = req.session?.username || 'unknown';
    console.log(`[ADMIN] ${user}: ${action}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC API (existing)
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/content', async (req, res) => {
    try {
        const content = await readContent();
        const { admin, ...pub } = content;
        if (pub.writings) pub.writings = pub.writings.filter(w => w.status !== 'draft');
        res.json(pub);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to read content' });
    }
});

app.get('/api/content/:section', async (req, res) => {
    try {
        const content = await readContent();
        const { section } = req.params;
        if (section === 'admin') return res.status(403).json({ error: 'Access denied' });
        if (content[section] === undefined) return res.status(404).json({ error: 'Section not found' });
        let data = content[section];
        if (section === 'writings' && Array.isArray(data)) data = data.filter(w => w.status !== 'draft');
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to read content' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  AUTH (existing)
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', loginLimiter, csrfCheck, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
        const content = await readContent();
        const valid = username === content.admin.username &&
                      await bcrypt.compare(String(password), content.admin.passwordHash);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

        req.session.regenerate(err => {
            if (err) return res.status(500).json({ error: 'Session error' });
            req.session.authenticated = true;
            req.session.username = username;
            req.session.csrfToken = crypto.randomBytes(32).toString('hex');
            res.cookie('XSRF-TOKEN', req.session.csrfToken, {
                sameSite: 'lax',
                secure: process.env.NODE_ENV === 'production',
                httpOnly: false,
            });
            res.json({ success: true });
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Login failed' });
    }
});

app.post('/api/auth/logout', csrfCheck, (req, res) => {
    req.session.destroy(() => { res.clearCookie('sid'); res.json({ success: true }); });
});

app.get('/api/auth/status', (req, res) => {
    res.json({ authenticated: !!req.session?.authenticated, username: req.session?.username || null });
});

app.post('/api/auth/change-password', requireAuth, csrfCheck, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords are required' });
        if (String(newPassword).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
        const content = await readContent();
        if (!await bcrypt.compare(String(currentPassword), content.admin.passwordHash)) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }
        content.admin.passwordHash = await bcrypt.hash(String(newPassword), SALT_ROUNDS);
        await writeContent(content);
        res.json({ success: true, message: 'Password changed successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN API — existing content (protected JSON endpoints)
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/admin/content-full', requireAuth, async (req, res) => {
    try { const content = await readContent(); const { admin, ...pub } = content; res.json(pub); }
    catch (err) { console.error(err); res.status(500).json({ error: 'Failed to read content' }); }
});

app.put('/api/admin/content/:section', requireAuth, csrfCheck, async (req, res) => {
    try {
        const { section } = req.params;
        if (section === 'admin') return res.status(403).json({ error: 'Use auth endpoints for admin changes' });
        const content = await readContent();
        content[section] = req.body;
        await writeContent(content);
        res.json({ success: true, message: `${section} updated successfully` });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update content' }); }
});

app.put('/api/admin/site', requireAuth, csrfCheck, async (req, res) => {
    try {
        const content = await readContent();
        content.site = { ...content.site, ...req.body };
        await writeContent(content);
        res.json({ success: true, message: 'Site settings updated' });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update site settings' }); }
});

// Writings CRUD
app.post('/api/admin/writings', requireAuth, csrfCheck, async (req, res) => {
    try {
        const content = await readContent();
        const writing = { id: 'w' + Date.now(), ...req.body };
        content.writings.unshift(writing);
        await writeContent(content);
        res.json({ success: true, writing });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to add writing' }); }
});

app.put('/api/admin/writings/:id', requireAuth, csrfCheck, async (req, res) => {
    try {
        const content = await readContent();
        const idx = content.writings.findIndex(w => w.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Writing not found' });
        content.writings[idx] = { ...content.writings[idx], ...req.body };
        await writeContent(content);
        res.json({ success: true, writing: content.writings[idx] });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update writing' }); }
});

app.delete('/api/admin/writings/:id', requireAuth, csrfCheck, async (req, res) => {
    try {
        const content = await readContent();
        content.writings = content.writings.filter(w => w.id !== req.params.id);
        await writeContent(content);
        res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to delete writing' }); }
});

// Events CRUD
app.post('/api/admin/events', requireAuth, csrfCheck, async (req, res) => {
    try {
        const content = await readContent();
        const event = { id: 'e' + Date.now(), ...req.body };
        content.events.list.unshift(event);
        await writeContent(content);
        res.json({ success: true, event });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to add event' }); }
});

app.put('/api/admin/events/:id', requireAuth, csrfCheck, async (req, res) => {
    try {
        const content = await readContent();
        const idx = content.events.list.findIndex(e => e.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Event not found' });
        content.events.list[idx] = { ...content.events.list[idx], ...req.body };
        await writeContent(content);
        res.json({ success: true, event: content.events.list[idx] });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update event' }); }
});

app.delete('/api/admin/events/:id', requireAuth, csrfCheck, async (req, res) => {
    try {
        const content = await readContent();
        content.events.list = content.events.list.filter(e => e.id !== req.params.id);
        await writeContent(content);
        res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to delete event' }); }
});

// Services CRUD
app.post('/api/admin/services', requireAuth, csrfCheck, async (req, res) => {
    try {
        const content = await readContent();
        const service = { id: 's' + Date.now(), ...req.body };
        content.management.services.push(service);
        await writeContent(content);
        res.json({ success: true, service });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to add service' }); }
});

app.put('/api/admin/services/:id', requireAuth, csrfCheck, async (req, res) => {
    try {
        const content = await readContent();
        const idx = content.management.services.findIndex(s => s.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Service not found' });
        content.management.services[idx] = { ...content.management.services[idx], ...req.body };
        await writeContent(content);
        res.json({ success: true, service: content.management.services[idx] });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update service' }); }
});

app.delete('/api/admin/services/:id', requireAuth, csrfCheck, async (req, res) => {
    try {
        const content = await readContent();
        content.management.services = content.management.services.filter(s => s.id !== req.params.id);
        await writeContent(content);
        res.json({ success: true });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to delete service' }); }
});

// Newsletter
app.post('/api/newsletter/subscribe', csrfCheck, async (req, res) => {
    try {
        const rawEmail = String(req.body.email || '').trim();
        const rawName  = String(req.body.name  || '').trim().slice(0, 100);
        if (!rawEmail || !validator.isEmail(rawEmail)) {
            return res.status(400).json({ error: 'Please enter a valid email address.' });
        }
        const email = validator.normalizeEmail(rawEmail) || rawEmail.toLowerCase();
        const content = await readContent();
        if (!content.newsletter) content.newsletter = { subscribers: [] };
        if (content.newsletter.subscribers.some(s => s.email === email)) {
            return res.status(409).json({ error: 'This email is already subscribed.' });
        }
        content.newsletter.subscribers.push({ id: 'sub_' + Date.now(), name: rawName, email, subscribedAt: new Date().toISOString() });
        await writeContent(content);
        res.json({ message: "You're on the list. Thank you." });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to subscribe. Please try again.' }); }
});

app.get('/api/admin/newsletter/subscribers', requireAuth, async (req, res) => {
    try { const content = await readContent(); res.json(content.newsletter?.subscribers || []); }
    catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch subscribers' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN EJS PAGES — Projects
//  All routes protected by requireAuthPage (redirects to /admin for login).
//  Forms include a hidden _csrf field, validated by csrfCheck.
// ─────────────────────────────────────────────────────────────────────────────

app.get('/admin/projects', requireAuthPage, async (req, res) => {
    try {
        const { list } = await readJson(DATA_FILES.projects);
        res.render('admin/projects', {
            projects: list,
            csrfToken: req.session.csrfToken,
            flash: req.session.flash || null,
        });
        delete req.session.flash;
    } catch (err) {
        console.error(err);
        res.status(500).send('Failed to load projects');
    }
});

app.get('/admin/projects/new', requireAuthPage, (req, res) => {
    res.render('admin/project-form', {
        project: null,
        csrfToken: req.session.csrfToken,
        error: null,
    });
});

app.get('/admin/projects/:id/edit', requireAuthPage, async (req, res) => {
    try {
        const { list } = await readJson(DATA_FILES.projects);
        const project = list.find(p => p.id === req.params.id);
        if (!project) return res.status(404).send('Project not found');
        res.render('admin/project-form', { project, csrfToken: req.session.csrfToken, error: null });
    } catch (err) {
        console.error(err);
        res.status(500).send('Failed to load project');
    }
});

// Create project
app.post('/admin/projects', requireAuthPage, csrfCheck, async (req, res) => {
    try {
        const title   = String(req.body.title   || '').trim().slice(0, 200);
        const content = String(req.body.content || '').trim();
        const url      = String(req.body.url      || '').trim();
        const imageUrl = String(req.body.imageUrl || '').trim();
        const excerpt  = String(req.body.excerpt  || '').trim().slice(0, 500);

        if (!title)   return res.render('admin/project-form', { project: null, csrfToken: req.session.csrfToken, error: 'Title is required' });
        if (!content) return res.render('admin/project-form', { project: null, csrfToken: req.session.csrfToken, error: 'Content is required' });
        if (url      && !validator.isURL(url,      { require_protocol: true })) return res.render('admin/project-form', { project: null, csrfToken: req.session.csrfToken, error: 'Project URL must be a valid URL' });
        if (imageUrl && !validator.isURL(imageUrl, { require_protocol: true }) && !imageUrl.startsWith('/')) {
            return res.render('admin/project-form', { project: null, csrfToken: req.session.csrfToken, error: 'Image URL must be a valid URL or a path starting with /' });
        }

        const data = await readJson(DATA_FILES.projects);
        const now  = new Date().toISOString();
        let slug   = slugify(title);
        // Ensure slug is unique within projects
        const existing = new Set(data.list.map(p => p.slug));
        if (existing.has(slug)) slug = `${slug}-${Date.now()}`;

        const project = { id: 'p' + Date.now(), title, slug, excerpt, content, url, imageUrl, createdAt: now, updatedAt: now };
        data.list.unshift(project);
        await writeJson(DATA_FILES.projects, data);

        logAction(req, `created project: ${title}`);
        req.session.flash = { type: 'success', msg: `Project "${title}" created.` };
        res.redirect('/admin/projects');
    } catch (err) {
        console.error(err);
        res.status(500).send('Failed to create project');
    }
});

// Update project
app.post('/admin/projects/:id', requireAuthPage, csrfCheck, async (req, res) => {
    try {
        const data  = await readJson(DATA_FILES.projects);
        const idx   = data.list.findIndex(p => p.id === req.params.id);
        if (idx === -1) return res.status(404).send('Project not found');

        const title   = String(req.body.title   || '').trim().slice(0, 200);
        const content = String(req.body.content || '').trim();
        const url      = String(req.body.url      || '').trim();
        const imageUrl = String(req.body.imageUrl || '').trim();
        const excerpt  = String(req.body.excerpt  || '').trim().slice(0, 500);

        if (!title)   return res.render('admin/project-form', { project: data.list[idx], csrfToken: req.session.csrfToken, error: 'Title is required' });
        if (!content) return res.render('admin/project-form', { project: data.list[idx], csrfToken: req.session.csrfToken, error: 'Content is required' });
        if (url      && !validator.isURL(url,      { require_protocol: true })) return res.render('admin/project-form', { project: data.list[idx], csrfToken: req.session.csrfToken, error: 'Project URL must be a valid URL' });

        data.list[idx] = { ...data.list[idx], title, excerpt, content, url, imageUrl, updatedAt: new Date().toISOString() };
        await writeJson(DATA_FILES.projects, data);

        logAction(req, `updated project: ${title}`);
        req.session.flash = { type: 'success', msg: `Project "${title}" saved.` };
        res.redirect('/admin/projects');
    } catch (err) {
        console.error(err);
        res.status(500).send('Failed to update project');
    }
});

// Delete project
app.post('/admin/projects/:id/delete', requireAuthPage, csrfCheck, async (req, res) => {
    try {
        const data = await readJson(DATA_FILES.projects);
        const project = data.list.find(p => p.id === req.params.id);
        data.list = data.list.filter(p => p.id !== req.params.id);
        await writeJson(DATA_FILES.projects, data);
        logAction(req, `deleted project: ${project?.title || req.params.id}`);
        req.session.flash = { type: 'success', msg: 'Project deleted.' };
        res.redirect('/admin/projects');
    } catch (err) {
        console.error(err);
        res.status(500).send('Failed to delete project');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN EJS PAGES — Posts (Blog)
// ─────────────────────────────────────────────────────────────────────────────

app.get('/admin/posts', requireAuthPage, async (req, res) => {
    try {
        const { list } = await readJson(DATA_FILES.posts);
        res.render('admin/posts', {
            posts: list,
            csrfToken: req.session.csrfToken,
            flash: req.session.flash || null,
        });
        delete req.session.flash;
    } catch (err) {
        console.error(err);
        res.status(500).send('Failed to load posts');
    }
});

app.get('/admin/posts/new', requireAuthPage, (req, res) => {
    res.render('admin/post-form', { post: null, csrfToken: req.session.csrfToken, error: null });
});

app.get('/admin/posts/:id/edit', requireAuthPage, async (req, res) => {
    try {
        const { list } = await readJson(DATA_FILES.posts);
        const post = list.find(p => p.id === req.params.id);
        if (!post) return res.status(404).send('Post not found');
        res.render('admin/post-form', { post, csrfToken: req.session.csrfToken, error: null });
    } catch (err) {
        console.error(err);
        res.status(500).send('Failed to load post');
    }
});

// Create post
app.post('/admin/posts', requireAuthPage, csrfCheck, async (req, res) => {
    try {
        const title   = String(req.body.title   || '').trim().slice(0, 200);
        const content = String(req.body.content || '').trim();
        const excerpt = String(req.body.excerpt || '').trim().slice(0, 500);
        const status  = req.body.status === 'draft' ? 'draft' : 'published';

        if (!title)   return res.render('admin/post-form', { post: null, csrfToken: req.session.csrfToken, error: 'Title is required' });
        if (!content) return res.render('admin/post-form', { post: null, csrfToken: req.session.csrfToken, error: 'Content is required' });

        const data = await readJson(DATA_FILES.posts);
        const now  = new Date().toISOString();
        let slug   = slugify(title);
        const existing = new Set(data.list.map(p => p.slug));
        if (existing.has(slug)) slug = `${slug}-${Date.now()}`;

        const post = { id: 'b' + Date.now(), title, slug, excerpt, content, status, createdAt: now, updatedAt: now };
        data.list.unshift(post);
        await writeJson(DATA_FILES.posts, data);

        logAction(req, `created post: ${title} [${status}]`);
        req.session.flash = { type: 'success', msg: `Post "${title}" ${status === 'draft' ? 'saved as draft' : 'published'}.` };
        res.redirect('/admin/posts');
    } catch (err) {
        console.error(err);
        res.status(500).send('Failed to create post');
    }
});

// Update post
app.post('/admin/posts/:id', requireAuthPage, csrfCheck, async (req, res) => {
    try {
        const data = await readJson(DATA_FILES.posts);
        const idx  = data.list.findIndex(p => p.id === req.params.id);
        if (idx === -1) return res.status(404).send('Post not found');

        const title   = String(req.body.title   || '').trim().slice(0, 200);
        const content = String(req.body.content || '').trim();
        const excerpt = String(req.body.excerpt || '').trim().slice(0, 500);
        const status  = req.body.status === 'draft' ? 'draft' : 'published';

        if (!title)   return res.render('admin/post-form', { post: data.list[idx], csrfToken: req.session.csrfToken, error: 'Title is required' });
        if (!content) return res.render('admin/post-form', { post: data.list[idx], csrfToken: req.session.csrfToken, error: 'Content is required' });

        data.list[idx] = { ...data.list[idx], title, excerpt, content, status, updatedAt: new Date().toISOString() };
        await writeJson(DATA_FILES.posts, data);

        logAction(req, `updated post: ${title} [${status}]`);
        req.session.flash = { type: 'success', msg: `Post "${title}" saved.` };
        res.redirect('/admin/posts');
    } catch (err) {
        console.error(err);
        res.status(500).send('Failed to update post');
    }
});

// Delete post
app.post('/admin/posts/:id/delete', requireAuthPage, csrfCheck, async (req, res) => {
    try {
        const data = await readJson(DATA_FILES.posts);
        const post = data.list.find(p => p.id === req.params.id);
        data.list = data.list.filter(p => p.id !== req.params.id);
        await writeJson(DATA_FILES.posts, data);
        logAction(req, `deleted post: ${post?.title || req.params.id}`);
        req.session.flash = { type: 'success', msg: 'Post deleted.' };
        res.redirect('/admin/posts');
    } catch (err) {
        console.error(err);
        res.status(500).send('Failed to delete post');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

// Markdown preview — render on the server so the preview matches published output exactly
app.post('/admin/preview', requireAuth, csrfCheck, (req, res) => {
    const html = renderMarkdown(req.body.content || '');
    res.json({ html });
});

// Image upload — saves to DATA_DIR/uploads/, returns the public URL
app.post('/admin/upload', requireAuth, csrfCheck, upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    logAction(req, `uploaded image: ${req.file.filename}`);
    res.json({ url: `/uploads/${req.file.filename}` });
}, (err, req, res, next) => {
    // Multer error handler
    res.status(400).json({ error: err.message || 'Upload failed' });
});

// JSON API for projects (mobile / SPA use)
app.get('/api/projects', async (req, res) => {
    try { const { list } = await readJson(DATA_FILES.projects); res.json(list); }
    catch (err) { res.status(500).json({ error: 'Failed to read projects' }); }
});

app.get('/api/posts', async (req, res) => {
    try {
        const { list } = await readJson(DATA_FILES.posts);
        res.json(list.filter(p => p.status !== 'draft'));
    } catch (err) { res.status(500).json({ error: 'Failed to read posts' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC EJS PAGES — Projects
// ─────────────────────────────────────────────────────────────────────────────

app.get('/projects', async (req, res) => {
    try {
        const { list } = await readJson(DATA_FILES.projects);
        res.render('public/projects', { projects: list });
    } catch (err) {
        console.error(err);
        res.status(500).send('Failed to load projects');
    }
});

app.get('/projects/:slug', async (req, res) => {
    try {
        const { list } = await readJson(DATA_FILES.projects);
        const project = list.find(p => p.slug === req.params.slug);
        if (!project) return res.status(404).render('public/404', { page: 'Project' });
        res.render('public/project', {
            project,
            contentHtml: renderMarkdown(project.content),
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Failed to load project');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC EJS PAGES — Blog
// ─────────────────────────────────────────────────────────────────────────────

app.get('/blog', async (req, res) => {
    try {
        const { list } = await readJson(DATA_FILES.posts);
        res.render('public/blog', { posts: list.filter(p => p.status !== 'draft') });
    } catch (err) {
        console.error(err);
        res.status(500).send('Failed to load blog');
    }
});

app.get('/blog/:slug', async (req, res) => {
    try {
        const { list } = await readJson(DATA_FILES.posts);
        const post = list.find(p => p.slug === req.params.slug && p.status !== 'draft');
        if (!post) return res.status(404).render('public/404', { page: 'Post' });
        res.render('public/post', {
            post,
            contentHtml: renderMarkdown(post.content),
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Failed to load post');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  STATIC HTML PAGE ROUTES (existing)
// ─────────────────────────────────────────────────────────────────────────────

const PAGES = {
    '/':           'index',
    '/about':      'about',
    '/writing':    'writing',
    '/management': 'management',
    '/events':     'events',
    '/contact':    'contact',
};

Object.entries(PAGES).forEach(([route, file]) => {
    app.get(route, (req, res) =>
        res.sendFile(path.join(__dirname, 'public', `${file}.html`)));
});

app.get('/subscribe', (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'subscribe.html')));

const WRITING_CATEGORIES = ['essays', 'poetry', 'commentary'];
WRITING_CATEGORIES.forEach(cat => {
    app.get(`/writing/${cat}`, (req, res) =>
        res.sendFile(path.join(__dirname, 'public', 'writing-category.html')));
});

app.get('/writing/:category/:slug', (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'writing-detail.html')));

app.get('/admin', (req, res) =>
    res.sendFile(path.join(__dirname, 'admin', 'index.html')));

// ─────────────────────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`NassrWrites CMS running on http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);
    console.log(`Projects:    http://localhost:${PORT}/admin/projects`);
    console.log(`Posts:       http://localhost:${PORT}/admin/posts`);
});
