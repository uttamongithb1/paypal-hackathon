#!/usr/bin/env node
/**
 * Writes one lightweight SVG per seeded product into `shop/products/<slug>.svg`.
 * The catalogue references those paths, and generating them keeps the storefront 100% offline:
 * no CDN, no image hosting, no broken thumbnails in a demo or a sandboxed preview.
 *
 *   node scripts/generate-product-art.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const outDir = path.join(appRoot, 'shop', 'products');
const catalogPaths = [
  path.join(appRoot, '..', 'data', 'seed.catalog.json'),
  path.join(appRoot, 'data', 'seed.catalog.json')
];

const catalogPath = catalogPaths.find((candidate) => fs.existsSync(candidate));
if (!catalogPath) {
  console.error('Could not find data/seed.catalog.json next to the app folder.');
  process.exit(1);
}

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const products = catalog.products ?? catalog.items ?? [];

const GLYPHS = {
  laptops: 'M40 34h144v86H40zM30 128h164v12H30zM78 148h68',
  phones: 'M84 24h56v132H84zM104 144h16',
  headphones: 'M50 104V88a62 62 0 0 1 124 0v16M50 104h22v40H56a6 6 0 0 1-6-6zM150 104h22v34a6 6 0 0 1-6 6h-16z',
  monitors: 'M34 30h172v96H34zM96 152h48M120 126v26',
  default: 'M40 34h160v100H40z'
};

const hash = (value) => {
  let h = 2166136261;
  for (let i = 0; i < String(value).length; i += 1) {
    h ^= String(value).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
};

fs.mkdirSync(outDir, { recursive: true });
let written = 0;

for (const product of products) {
  const seed = hash(product.slug ?? product.title);
  const hue = seed % 360;
  const hue2 = (hue + 34) % 360;
  const glyph = GLYPHS[product.categorySlug] ?? GLYPHS.default;
  const initials = String(product.title ?? '')
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200" width="320" height="200" role="img" aria-label="${product.title}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue} 62% 92%)"/>
      <stop offset="100%" stop-color="hsl(${hue2} 58% 82%)"/>
    </linearGradient>
  </defs>
  <rect width="320" height="200" fill="url(#g)"/>
  <g transform="translate(120 60) scale(1.1)" fill="none" stroke="hsl(${hue} 45% 34%)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
    <path d="${glyph}"/>
  </g>
  <text x="300" y="182" text-anchor="end" font-family="Inter, system-ui, sans-serif" font-size="34" font-weight="700" fill="hsl(${hue} 45% 30%)" opacity="0.35">${initials}</text>
</svg>
`;
  fs.writeFileSync(path.join(outDir, `${product.slug}.svg`), svg);
  written += 1;
}

console.log(`  Wrote ${written} product images to ${path.relative(process.cwd(), outDir)}/`);
console.log('  Reference them as /products/<slug>.svg — same origin, no CDN.\n');
