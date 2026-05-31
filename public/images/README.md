# /public/images

Static image assets for nassrwrites.com. Each folder maps to a URL prefix — e.g. a file at `portrait/nassr.jpg` is served at `/images/portrait/nassr.jpg`.

## Folders

| Folder | Purpose | Naming suggestion |
|--------|---------|-------------------|
| `portrait/` | Main portrait of Nassr — used on homepage and About page | `nassr.jpg`, `nassr-2.jpg` |
| `events/` | Event gallery photos — past and upcoming events | `[event-slug]-01.jpg`, `[event-slug]-02.jpg` |
| `social/` | Social media update images — Instagram posts, announcements | `[YYYY-MM-DD]-[short-desc].jpg` |
| `artists/` | Photos of artists under management or featured collaborators | `[artist-name].jpg` |
| `writing/` | Cover/hero images for essays and writing pieces | `[writing-slug].jpg` |
| `og/` | Open Graph images used as social share cards (1200×630 px) | `[page-name]-og.jpg` |

## Format guidelines

- Prefer **JPEG** for photographs, **WebP** for web-optimised versions
- Portrait: at least **800×1000 px**, cropped to face/upper body
- Event gallery: at least **1200×800 px** landscape
- OG images: exactly **1200×630 px**
- Keep filenames lowercase, no spaces — use hyphens
