/**
 * Import product photography from public dummy product APIs.
 *
 *   node scripts/import-product-photos.mjs [--force]
 *
 * Where the pictures come from
 * ----------------------------
 * Two public, key-less catalogue APIs: DummyJSON (laptops, smartphones, audio) and Fake Store
 * (electronics — it is the only one of the two with monitor photography). Products that neither
 * source covers use a locally generated studio shot.
 *
 * Why the images are vendored instead of hot-linked
 * -------------------------------------------------
 * The shop's whole claim is that the *server* knows the stock and the price. If the pictures were
 * hot-linked, a rate-limited or retired free API would leave a judge looking at a shop full of
 * broken images at 2am — the catalogue record would still be correct, but the demo would look
 * broken. So this is an import step, not a runtime dependency: the bytes land in shop/products/
 * and the app never calls either API at request time. Same reason the seed catalogue is a file.
 *
 * Provenance is written to ../data/product-photo-sources.json so every image can be traced back to
 * the product it came from.
 *
 * Photography is matched by *form factor*, not by brand: this is a fictional catalogue (Vertex,
 * NovaTech, AudioPeak), so a real 14-inch laptop photo stands in for the fictional 14-inch laptop.
 * Nothing in the storefront claims the photo depicts the exact SKU — the alt text describes the
 * form factor only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const PRODUCT_DIR = path.join(APP_ROOT, 'shop', 'products');
const CATALOG_PATH = path.join(APP_ROOT, '..', 'data', 'seed.catalog.json');
const PROVENANCE_PATH = path.join(APP_ROOT, '..', 'data', 'product-photo-sources.json');

const DUMMYJSON = 'https://dummyjson.com/products?limit=200&select=title,thumbnail,images,category';
const FAKESTORE = 'https://fakestoreapi.com/products/category/electronics';

/**
 * slug -> { api, match, alt }
 * `match` is looked up against the source API's product title. `generated` entries are studio
 * shots produced locally because neither API covers that form factor.
 */
const MAPPING = {
  // ── Laptops ────────────────────────────────────────────────────────────────────────────────
  'ascent-book-14-pro': { api: 'dummyjson', match: 'Apple MacBook Pro 14 Inch', alt: 'A 14-inch aluminium laptop, lid open, photographed against white' },
  'ascent-book-14': { api: 'dummyjson', match: 'New DELL XPS 13 9300', alt: 'A compact 13-inch ultrabook, lid open, photographed against white' },
  'vertex-ultra-15': { api: 'dummyjson', match: 'Lenovo Yoga 920', alt: 'A convertible 15-inch laptop on a white background' },
  'vertex-progamer-16': { api: 'dummyjson', match: 'Asus Zenbook Pro Dual Screen', alt: 'A large gaming laptop shown from the side, photographed against white' },
  'novabook-air-13': { api: 'dummyjson', match: 'Huawei Matebook X Pro', alt: 'A thin silver 13-inch laptop, photographed against white' },
  'novabook-studio-15': { api: 'generated', alt: 'A 15-inch creator laptop, lid open, photographed against white' },
  'playbook-go-14': { api: 'generated', alt: 'A low-cost 14-inch laptop, lid open, photographed against white' },
  'ascent-book-16-creator': { api: 'generated', alt: 'A 16-inch creator laptop with a large screen, photographed against white' },

  // ── Phones ─────────────────────────────────────────────────────────────────────────────────
  'novatech-pulse-5': { api: 'dummyjson', match: 'Oppo F19 Pro Plus', alt: 'A mid-range smartphone, front and back, photographed against white' },
  'novatech-pulse-5-pro': { api: 'dummyjson', match: 'iPhone 13 Pro', alt: 'A flagship smartphone shown from the back, photographed against white' },
  'novatech-pulse-4a': { api: 'dummyjson', match: 'Oppo A57', alt: 'An entry-level smartphone on a white background' },
  'vertex-v-phone-12': { api: 'dummyjson', match: 'iPhone X', alt: 'A smartphone with a glass back, photographed against white' },
  'vertex-v-phone-12-max': { api: 'dummyjson', match: 'Samsung Galaxy S10', alt: 'A large-screened smartphone, photographed against white' },
  'playbook-lite-4': { api: 'dummyjson', match: 'Realme C35', alt: 'A budget smartphone photographed against white' },

  // ── Headphones ─────────────────────────────────────────────────────────────────────────────
  'aeropeak-aero-anc-studio': { api: 'dummyjson', match: 'Apple AirPods Max', alt: 'Over-ear noise-cancelling headphones photographed against white' },
  'aeropeak-aero-anc-lite': { api: 'dummyjson', match: 'Apple Airpods', alt: 'Compact true-wireless earbuds in their case, against white' },
  'aeropeak-flight-pro': { api: 'dummyjson', match: 'Beats Flex Wireless', alt: 'Neckband wireless earphones photographed against white' },
  'aeropeak-studio-one-wired': { api: 'generated', alt: 'Wired studio monitor headphones with a coiled cable, against white' },
  'aeropeak-buds-mini-anc': { api: 'generated', alt: 'Small wireless earbuds with a charging case, against white' },

  // ── Monitors ───────────────────────────────────────────────────────────────────────────────
  'vview-24-fhd': { api: 'fakestore', match: 'Acer SB220Q', alt: 'A 24-inch desktop monitor photographed against white' },
  'novatech-view-ultrawide-34': { api: 'fakestore', match: 'Samsung 49-Inch CHG90', alt: 'An ultrawide curved monitor photographed against white' },
  'vview-27-qhd': { api: 'generated', alt: 'A 27-inch QHD monitor on a slim stand, against white' },
  'novatech-view-27-144hz': { api: 'generated', alt: 'A 27-inch high-refresh gaming monitor, against white' },
  'vview-32-4k': { api: 'generated', alt: 'A 32-inch 4K monitor photographed against white' }
};

const EXT_FROM_TYPE = { 'image/webp': '.webp', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg' };

/** Is ImageMagick on this machine? It is only needed for normalisation, never at runtime. */
function hasMagick() {
  try {
    execFileSync('magick', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Source photos arrive at wildly different sizes and aspect ratios (300x300 thumbnails, 575x434
 * PNGs, 1000x1000 renders). Normalising them to one square canvas on white is what makes a grid
 * of them read as a single shop rather than a collage.
 */
function normalise(filePath, { size = 800, quality = 86 } = {}) {
  execFileSync('magick', [
    filePath,
    '-resize', `${size}x${size}>`,
    '-background', 'white',
    '-gravity', 'center',
    '-extent', `${size}x${size}`,
    '-strip',
    '-quality', String(quality),
    filePath
  ], { stdio: 'ignore' });
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function fetchImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const ext = EXT_FROM_TYPE[type] ?? path.extname(new URL(url).pathname) ?? '.jpg';
  return { bytes: Buffer.from(await res.arrayBuffer()), ext, type };
}

/** Patch one product's single-line "images" entry, leaving the rest of the file byte-for-byte. */
function patchCatalog(entries) {
  const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
  let next = raw;
  for (const { slug, file, alt } of entries) {
    const slugLine = `"slug": "${slug}"`;
    const start = next.indexOf(slugLine);
    if (start === -1) throw new Error(`catalogue is missing slug ${slug}`);
    const imagesAt = next.indexOf('"images":', start);
    if (imagesAt === -1) throw new Error(`${slug} has no images field`);
    const lineEnd = next.indexOf('\n', imagesAt);
    const replacement = `"images": [{ "url": "/products/${file}", "alt": ${JSON.stringify(alt)} }],`;
    next = `${next.slice(0, imagesAt)}${replacement}${next.slice(lineEnd)}`;
  }
  fs.writeFileSync(CATALOG_PATH, next);
  return raw !== next;
}

const force = process.argv.includes('--force');
const magick = hasMagick();
fs.mkdirSync(PRODUCT_DIR, { recursive: true });
if (!magick) console.log('  ! ImageMagick not found — images are saved unnormalised.');

console.log('Fetching catalogue listings…');
const [dummy, fake] = await Promise.all([fetchJson(DUMMYJSON), fetchJson(FAKESTORE)]);
const pools = {
  // Full-size images[0] (1000x1000) rather than the 300x300 thumbnail: cards render at ~340 css px
  // and retina doubles that, so the thumbnail would look soft on any modern laptop.
  dummyjson: dummy.products.map((p) => ({ title: p.title, image: p.images?.[0] ?? p.thumbnail })),
  fakestore: fake.map((p) => ({ title: p.title, image: p.image }))
};

const entries = [];
const provenance = { $comment: 'Photo provenance for data/seed.catalog.json. Regenerate with: node app/scripts/import-product-photos.mjs --force', sources: { dummyjson: 'https://dummyjson.com', fakestore: 'https://fakestoreapi.com' }, products: {} };
let downloaded = 0;
let reused = 0;
const missing = [];

for (const [slug, spec] of Object.entries(MAPPING)) {
  const existing = fs.readdirSync(PRODUCT_DIR).find((f) => f.replace(path.extname(f), '') === slug && f !== `${slug}.svg`);
  if (spec.api === 'generated') {
    if (!existing) missing.push(slug);
    if (existing) entries.push({ slug, file: existing, alt: spec.alt });
    provenance.products[slug] = { source: 'local-generated', file: existing ?? null };
    continue;
  }
  if (existing && !force) {
    entries.push({ slug, file: existing, alt: spec.alt });
    provenance.products[slug] = { source: spec.api, file: existing, reused: true };
    reused += 1;
    continue;
  }
  const pool = pools[spec.api] ?? [];
  const hit = pool.find((p) => p.title.toLowerCase().includes(spec.match.toLowerCase()));
  if (!hit) throw new Error(`no ${spec.api} product matching "${spec.match}" for ${slug}`);
  const { bytes, ext: sourceExt, type } = await fetchImage(hit.image);
  const target = path.join(PRODUCT_DIR, `${slug}.${sourceExt === '.webp' ? 'webp' : sourceExt === '.png' ? 'png' : 'jpg'}`);
  fs.writeFileSync(target, bytes);
  let file = path.basename(target);
  if (magick) {
    normalise(target);
    // Re-encode anything that is not already webp so the shop serves one format.
    if (!file.endsWith('.webp')) {
      const webp = target.replace(/\.[^.]+$/, '.webp');
      normalise(target, { size: 800 });
      execFileSync('magick', [target, '-quality', '86', webp], { stdio: 'ignore' });
      fs.unlinkSync(target);
      file = path.basename(webp);
    }
  }
  entries.push({ slug, file, alt: spec.alt });
  provenance.products[slug] = {
    source: spec.api,
    sourceProduct: hit.title,
    sourceUrl: hit.image,
    file,
    contentType: type,
    bytes: bytes.length,
    retrieved: new Date().toISOString().slice(0, 10)
  };
  downloaded += 1;
  process.stdout.write(`  ↓ ${file} (${Math.round(bytes.length / 1024)} KB)\n`);
}

fs.writeFileSync(PROVENANCE_PATH, `${JSON.stringify(provenance, null, 2)}\n`);
const changed = patchCatalog(entries);
console.log(`\n  downloaded ${downloaded} · reused ${reused} · catalogue ${changed ? 'updated' : 'unchanged'}`);
if (missing.length) {
  console.log(`\n  ${missing.length} product(s) still have no photo. Generate a studio shot and save it to`);
  console.log(`  shop/products/<slug>.webp, then re-run with --force:`);
  for (const slug of missing) console.log(`    · ${slug}`);
}
