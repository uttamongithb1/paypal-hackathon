/**
 * Requirement extraction. The deterministic extractor used by the planner (and as the fallback when
 * a live model fails to produce valid JSON). Docs: ../docs/ai_agent_spec.md §5
 */
import { formatMoney } from '../lib/money.mjs';

export const CATEGORY_KEYWORDS = {
  laptops: ['laptop', 'notebook', 'ultrabook', 'macbook', 'thinkpad', 'dev machine', 'development machine', 'workstation'],
  phones: ['phone', 'smartphone', 'iphone', 'android phone', 'handset'],
  headphones: ['headphone', 'headphones', 'earbud', 'earbuds', 'earphone', 'headset', 'anc', 'noise cancelling', 'noise-cancelling', 'noise canceling'],
  monitors: ['monitor', 'display', 'ultrawide', 'screen for my desk', 'second screen']
};

const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1, couple: 2 };

const AT_LEAST = /\b(at least|minimum|min|no less than|>=|over|more than|above)\b/i;
const AT_MOST = /\b(under|below|less than|max|maximum|no more than|up to|<=|within|cheaper than|budget of|budget is)\b/i;

const detectCategory = (text) => {
  const lower = text.toLowerCase();
  for (const [slug, words] of Object.entries(CATEGORY_KEYWORDS)) {
    if (words.some((w) => lower.includes(w))) return slug;
  }
  return null;
};

/**
 * Multipliers people actually type. "under 10k" means ten thousand, not ten — reading the digits and
 * dropping the suffix turned a 10,000 budget into a 10.00 one, which matched nothing and made the
 * agent look broken. Indian units are included because this store's shoppers write lakh and crore.
 */
const MULTIPLIERS = [
  [/^(k|thousand)\b/i, 1_000],
  [/^(lakh|lac|lakhs)\b/i, 100_000],
  [/^(cr|crore|crores)\b/i, 10_000_000],
  [/^(m|million|mn)\b/i, 1_000_000]
];

/** "10k" -> 10000, "1.5k" -> 1500, "2 lakh" -> 200000, "700" -> 700. */
const applyMultiplier = (digits, suffix) => {
  const value = Number(String(digits).replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  if (!suffix) return value;
  const hit = MULTIPLIERS.find(([pattern]) => pattern.test(suffix));
  return hit ? value * hit[1] : value;
};

const AMOUNT = String.raw`(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|lakh|lac|lakhs|cr|crore|crores|m|million|mn)?\b`;

const parseBudget = (text) => {
  const patterns = [
    new RegExp(String.raw`\$\s?${AMOUNT}`, 'i'),
    new RegExp(String.raw`${AMOUNT}\s?(?:usd|dollars|dollar|bucks)\b`, 'i'),
    new RegExp(String.raw`\b(?:under|below|less than|max|maximum|up to|within|budget(?: of| is)?)\s+\$?${AMOUNT}`, 'i')
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const value = applyMultiplier(match[1], match[2]);
      if (value !== null && Number.isFinite(value) && value > 0) return Math.round(value * 100);
    }
  }
  if (/\bcheap(est)?\b|\bbudget\b|\baffordable\b|\binexpensive\b/i.test(text)) return 'unspecified';
  return null;
};

/**
 * Finds the number that belongs to one of `keywords` and reports where it starts, so the
 * comparison cue can be read from the words next to *that* quantity.
 */
/** True when the digits at `index` are money ("$700", "under 900"), not a spec quantity. */
const looksLikePrice = (text, index) => {
  const before = text.slice(Math.max(0, index - 14), index);
  return /[$€£]\s*$/.test(before) || /\b(under|below|over|above|budget|max|maximum|up to|less than|more than|cheaper than)\s+$/.test(before);
};

const numberMatch = (text, keywords) => {
  for (const keyword of keywords) {
    const forms = [
      new RegExp(`(\\d[\\d.,]*)\\s*(gb|g|tb)?\\s*(?:of\\s*)?${keyword}`, 'i'),
      new RegExp(`${keyword}\\D{0,12}?(\\d[\\d.,]*)`, 'i')
    ];
    for (const re of forms) {
      const match = re.exec(text);
      if (match) {
        const index = match.index + match[0].indexOf(match[1]);
        if (looksLikePrice(text, index)) continue;
        return { value: Number(match[1].replace(/,/g, '')), unit: (match[2] ?? '').toLowerCase() || null, index };
      }
    }
  }
  return null;
};

/**
 * Comparison cues are scoped to the quantity they sit next to. "a laptop under $900 with 16 GB RAM"
 * means the budget is capped and the RAM is a minimum: the budget's "under" must not leak onto RAM.
 * A cue only counts when no other number sits between it and this quantity ("under $900 with" holds
 * a number, so it is ignored for the RAM).
 */
const CUE_BEFORE = /(at least|no less than|minimum|more than|above|over|under|below|less than|maximum|max|no more than|up to|within|cheaper than|min)([^.;,!?]{0,14})$/i;
const CUE_AFTER = /^\d[\d.,]*\s*(?:gb|g|tb|inch|inches|in|"|")?\s*(?:[a-z]{1,6}\s*)?(?:or\s*)?(more|above|minimum|min|at least|less|below|maximum|max)\b/i;
/**
 * Cue → operator. Compared as whole strings on purpose: "no more than" contains "more than" and
 * "no less than" contains "less than", so substring tests would invert the constraint.
 */
const cueOp = (cue) => {
  const c = String(cue).toLowerCase().trim();
  if (/^(no more than|max|maximum|up to|within|cheaper than|less than|below|under|at most)$/.test(c)) return 'lte';
  if (/^(no less than|at least|min|minimum|more than|above|over|plus)$/.test(c)) return 'gte';
  if (/^(less|fewer)$/.test(c)) return 'lte';
  if (/^(more|higher)$/.test(c)) return 'gte';
  return null;
};

const opNear = (text, index) => {
  const window = text.slice(Math.max(0, index - 32), index);
  const before = CUE_BEFORE.exec(window);
  if (before && !/\d/.test(before[2])) return cueOp(before[1]);
  const after = CUE_AFTER.exec(text.slice(index, index + 28));
  if (after) return cueOp(after[1]);
  return null;
};

const parseQuantity = (text) => {
  const match = /\b(?:add|buy|get|want|need|order)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an|couple)\b/i.exec(text);
  if (match) {
    const raw = match[1].toLowerCase();
    return NUM_WORDS[raw] ?? Number(raw) ?? 1;
  }
  const generic = /\b(\d+)\s*(?:x|×)\b/i.exec(text);
  if (generic) return Number(generic[1]);
  return null;
};

/** Public: extract a fresh requirement object from a message (+ the previous one for continuity). */
export function extractRequirement(message, { previous = null, attributeSchemas = {} } = {}) {
  const text = String(message ?? '');
  const lower = text.toLowerCase();
  const dropped = [];
  const assumptions = [];

  const requirement = {
    revision: previous?.revision ?? 0,
    categorySlug: previous?.categorySlug ?? null,
    budgetMinor: previous?.budgetMinor ?? null,
    budgetIsUnspecified: previous?.budgetIsUnspecified ?? false,
    hardConstraints: [...(previous?.hardConstraints ?? [])],
    softPreferences: [...(previous?.softPreferences ?? [])],
    useCase: previous?.useCase ?? null,
    quantity: previous?.quantity ?? 1,
    assumptions: [...(previous?.assumptions ?? [])]
  };

  const category = detectCategory(text);
  if (category) requirement.categorySlug = category;

  const budget = parseBudget(text);
  if (budget === 'unspecified') {
    requirement.budgetIsUnspecified = true;
    if (!requirement.assumptions.includes('budget: any')) requirement.assumptions.push('budget: any');
  } else if (typeof budget === 'number') {
    requirement.budgetMinor = budget;
    requirement.budgetIsUnspecified = false;
    requirement.assumptions = requirement.assumptions.filter((a) => a !== 'budget: any');
  }

  const schemaKeys = requirement.categorySlug ? (attributeSchemas[requirement.categorySlug] ?? []) : [];

  const addConstraint = (key, op, value, label) => {
    if (schemaKeys.length && !schemaKeys.some((a) => a.key === key)) {
      dropped.push(`${key} is not a filterable attribute for ${requirement.categorySlug}`);
      return;
    }
    requirement.hardConstraints = requirement.hardConstraints.filter((c) => !(c.kind === 'attribute' && c.key === key && c.op === op));
    requirement.hardConstraints.push({ kind: 'attribute', key, op, value, label });
  };
  const addSoft = (key, direction, label, weight = 0.6) => {
    requirement.softPreferences = requirement.softPreferences.filter((p) => p.key !== key);
    requirement.softPreferences.push({ key, direction, label, weight });
  };

  // RAM
  const genericRam = /\b(16|32|8|4)\s*gb\b/.exec(lower);
  const ramHit = numberMatch(lower, ['gb ram', 'ram']) ?? (genericRam && /ram|laptop|notebook/.test(lower) ? { value: Number(genericRam[1]), index: genericRam.index } : null);
  if (ramHit) {
    const op = opNear(lower, ramHit.index) ?? 'gte';
    addConstraint('ramGb', op, ramHit.value, `RAM ${op === 'gte' ? '≥' : '≤'} ${ramHit.value} GB`);
  }
  // Storage
  const tbFallback = /(\d+)\s?tb\b/.exec(lower);
  const storageHit =
    numberMatch(lower, ['ssd', 'storage', 'hard drive', 'tb ssd']) ??
    (tbFallback ? { value: Number(tbFallback[1]), unit: 'tb', index: tbFallback.index } : null);
  if (storageHit) {
    // "1 TB SSD" arrives as 1 + unit TB, and "storage: 1tb" as 1 + TB right after the number.
    const inTb = storageHit.unit === 'tb' || /^\d[\d.,]*\s?tb\b/i.test(lower.slice(storageHit.index, storageHit.index + 10));
    const value = inTb ? storageHit.value * 1024 : storageHit.value;
    addConstraint('storageGb', 'gte', value, `Storage ≥ ${value >= 1024 ? `${value / 1024} TB` : `${value} GB`}`);
  }
  // Weight ("lighter than 1.4 kg")
  const weightKg = /(\d(?:\.\d+)?)\s?kg/.exec(lower);
  if (weightKg && /(light|weigh|under|below|less than|lighter)/.test(lower)) {
    const grams = Math.round(Number(weightKg[1]) * 1000);
    addConstraint('weightG', 'lte', grams, `Weight ≤ ${weightKg[1]} kg`);
  }
  // Screen size
  const screen = /(\d{2}(?:\.\d)?)\s?(?:inch|in\b|-inch|"|”)/.exec(lower);
  if (screen) {
    const inches = Number(screen[1]);
    const op = opNear(lower, screen.index) ?? 'gte';
    addConstraint('screenIn', op, inches, `Screen ${op === 'gte' ? '≥' : '≤'} ${inches}"`);
  }
  // Noise cancelling
  if (/noise[- ]?cancel/i.test(lower)) addConstraint('noiseCancelling', 'eq', true, 'Noise cancelling');
  // 5G
  if (/\b5g\b/i.test(lower)) addConstraint('has5g', 'eq', true, '5G');
  // Refresh rate (monitors)
  const hz = /(\d{2,3})\s?hz/.exec(lower);
  if (hz) addConstraint('refreshHz', AT_MOST.test(text) ? 'lte' : 'gte', Number(hz[1]), `${hz[1]} Hz`);
  // Resolution (monitors)
  if (/\b4k\b|3840/.test(lower)) addConstraint('resolution', 'eq', '3840x2160', '4K');
  if (/\b1440p\b|qhd|2560/.test(lower)) addConstraint('resolution', 'eq', '2560x1440', '1440p');
  if (/\bultrawide\b/.test(lower)) addConstraint('resolution', 'eq', '3440x1440', 'Ultrawide 1440p');

  // Soft preferences (they influence order, never inclusion)
  if (/good battery|long battery|battery life|all day|battery/i.test(lower)) addSoft('batteryWh', 'higher_better', 'long battery life', 0.8);
  if (/light|portable|travel|carry/i.test(lower)) addSoft('weightG', 'lower_better', 'light weight', 0.6);
  if (/camera|photo|photograph/i.test(lower)) {
    if (schemaKeys.some((a) => a.key === 'cameraMp')) addSoft('cameraMp', 'higher_better', 'camera quality', 0.9);
  }
  if (/games|gaming|fps|high refresh/i.test(lower)) {
    if (schemaKeys.some((a) => a.key === 'refreshHz')) addConstraint('refreshHz', 'gte', 120, 'Gaming: 120 Hz+');
    else addSoft('ratingAvg', 'higher_better', 'gaming suitability', 0.4);
  }
  if (/upgrade|future|expandable/i.test(lower)) {
    if (schemaKeys.some((a) => a.key === 'upgradeableRam')) addConstraint('upgradeableRam', 'eq', true, 'Upgradeable RAM');
  }

  const quantity = parseQuantity(text);
  if (quantity) requirement.quantity = Math.min(10, Math.max(1, quantity));

  const useCaseMatch = /(?:for|use it for|mainly for)\s+([^.,;]{3,60})/i.exec(text);
  if (useCaseMatch) requirement.useCase = useCaseMatch[1].trim();
  else if (/full[- ]stack|web dev|development|programming|coding/i.test(lower)) requirement.useCase = 'software development';

  requirement.assumptions = [
    ...new Set([
      ...requirement.assumptions.filter((a) => a !== 'budget: any' || requirement.budgetIsUnspecified),
      ...(requirement.useCase ? [] : [])
    ])
  ];
  if (!requirement.budgetMinor && !requirement.budgetIsUnspecified && !requirement.assumptions.includes('budget: any') && /\blaptop|phone|monitor|headphone/i.test(lower)) {
    requirement.assumptions.push('budget: any');
  }

  return { requirement, dropped, changed: requirementChanged(previous, requirement) };
}

/** A revision bump happens only for money/eligibility-relevant changes (ai_agent_spec.md §5). */
export function requirementChanged(previous, next) {
  if (!previous) return true;
  const key = (r) =>
    JSON.stringify({
      categorySlug: r.categorySlug ?? null,
      budgetMinor: r.budgetMinor ?? null,
      budgetIsUnspecified: r.budgetIsUnspecified ?? false,
      hard: (r.hardConstraints ?? []).map((c) => `${c.key}${c.op}${c.value}`).sort()
    });
  return key(previous) !== key(next);
}

export function describeRequirement(requirement) {
  if (!requirement) return 'No requirement yet.';
  const parts = [];
  if (requirement.categorySlug) parts.push(requirement.categorySlug);
  if (requirement.budgetMinor) parts.push(`≤ ${formatMoney(requirement.budgetMinor)}`);
  else if (requirement.budgetIsUnspecified) parts.push('budget: any');
  for (const c of requirement.hardConstraints ?? []) parts.push(c.label ?? `${c.key} ${c.op} ${c.value}`);
  return parts.length ? parts.join(' · ') : 'No constraint yet.';
}

export function requirementChips(requirement) {
  if (!requirement) return [];
  const chips = [];
  if (requirement.categorySlug) chips.push({ id: 'category', kind: 'category', label: requirement.categorySlug, removable: true });
  if (requirement.budgetMinor) chips.push({ id: 'budget', kind: 'budget', label: `≤ ${formatMoney(requirement.budgetMinor)}`, value: requirement.budgetMinor, removable: true });
  for (const [index, constraint] of (requirement.hardConstraints ?? []).entries()) {
    chips.push({ id: `hard-${index}`, kind: 'hard', key: constraint.key, op: constraint.op, value: constraint.value, label: constraint.label ?? `${constraint.key} ${constraint.op} ${constraint.value}`, removable: true });
  }
  for (const [index, pref] of (requirement.softPreferences ?? []).entries()) {
    chips.push({ id: `soft-${index}`, kind: 'soft', key: pref.key, direction: pref.direction, label: `${pref.label ?? pref.key}`, removable: true });
  }
  for (const assumption of requirement.assumptions ?? []) {
    chips.push({ id: `assumption-${assumption}`, kind: 'assumption', label: assumption, removable: false });
  }
  return chips;
}

export const CLARIFY_QUESTIONS = {
  budget: {
    question: "What's your budget? I'll keep everything inside it.",
    options: ['< $500', '$500–$900', '$900–$1,500', 'No limit'],
    optionMap: { '< $500': 49900, '$500–$900': 90000, '$900–$1,500': 150000, 'No limit': 'any' }
  },
  category: {
    question: 'Which kind of product should I look at — laptops, phones, headphones or monitors?',
    options: ['Laptops', 'Phones', 'Headphones', 'Monitors']
  },
  use_case: {
    question: 'What will you mainly use it for?',
    options: ['Work / study', 'Gaming', 'Travel', 'Photography']
  }
};
