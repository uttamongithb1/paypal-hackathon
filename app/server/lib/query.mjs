/**
 * Tiny Mongo-style query engine for the file store: filter matching, sorting and projection.
 * Supports: equality, $eq/$ne/$gt/$gte/$lt/$lte/$in/$nin/$exists/$regex, dotted paths,
 * and { a: 1 } / { a: -1 } sorting. Kept intentionally small — it exists so the services can be
 * written against Mongo semantics and swapped to the real driver without changes.
 */

export function getPath(doc, path) {
  return path.split('.').reduce((acc, part) => (acc === undefined || acc === null ? undefined : acc[part]), doc);
}

function setPath(doc, path, value) {
  const parts = path.split('.');
  let cur = doc;
  for (const part of parts.slice(0, -1)) {
    if (typeof cur[part] !== 'object' || cur[part] === null) cur[part] = {};
    cur = cur[part];
  }
  cur[parts.at(-1)] = value;
}

export function applyPatch(doc, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('$inc' in value || '$set' in value || '$push' in value || '$unset' in value) {
        applyOperators(doc, { [key]: value });
        continue;
      }
    }
    setPath(doc, key, value);
  }
  return doc;
}

export function applyOperators(doc, operators) {
  for (const [rawKey, fields] of Object.entries(operators)) {
    // Mixed updates are allowed: plain keys behave as $set (Mongo rejects this; we accept it because
    // services write { status, $push } in one call and the store is the only writer).
    if (!rawKey.startsWith('$')) {
      setPath(doc, rawKey, fields);
      continue;
    }
    const op = rawKey;
    if (op === '$inc') for (const [path, by] of Object.entries(fields)) setPath(doc, path, (getPath(doc, path) ?? 0) + by);
    else if (op === '$set') for (const [path, value] of Object.entries(fields)) setPath(doc, path, value);
    else if (op === '$unset') for (const path of Object.keys(fields)) setPath(doc, path, undefined);
    else if (op === '$push') for (const [path, value] of Object.entries(fields)) {
      const arr = getPath(doc, path);
      if (!Array.isArray(arr)) setPath(doc, path, []);
      const target = getPath(doc, path);
      if (value && typeof value === 'object' && '$each' in value) target.push(...value.$each);
      else target.push(value);
    } else throw new Error(`Unsupported update operator ${op}`);
  }
  return doc;
}

function matchesCondition(value, condition) {
  if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
    return Array.isArray(value) ? value.includes(condition) : value === condition;
  }
  return Object.entries(condition).every(([op, operand]) => {
    switch (op) {
      case '$eq': return value === operand;
      case '$ne': return value !== operand;
      case '$gt': return value > operand;
      case '$gte': return value >= operand;
      case '$lt': return value < operand;
      case '$lte': return value <= operand;
      case '$in': return Array.isArray(operand) && operand.some((o) => (Array.isArray(value) ? value.includes(o) : value === o));
      case '$nin': return Array.isArray(operand) && !operand.some((o) => (Array.isArray(value) ? value.includes(o) : value === o));
      case '$exists': return operand ? value !== undefined : value === undefined;
      case '$regex': return new RegExp(operand, 'i').test(String(value ?? ''));
      case '$all': return Array.isArray(value) && operand.every((o) => value.includes(o));
      default: throw new Error(`Unsupported query operator ${op}`);
    }
  });
}

export function matches(doc, filter = {}) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$or') return condition.some((c) => matches(doc, c));
    if (key === '$and') return condition.every((c) => matches(doc, c));
    if (key === '$nor') return !condition.some((c) => matches(doc, c));
    const value = getPath(doc, key);
    if (Array.isArray(value) && typeof condition !== 'object') return value.includes(condition);
    return matchesCondition(value, condition);
  });
}

export function sortDocs(docs, sort) {
  if (!sort) return docs;
  const entries = Object.entries(sort);
  return [...docs].sort((a, b) => {
    for (const [path, dir] of entries) {
      const av = getPath(a, path);
      const bv = getPath(b, path);
      if (av === bv) continue;
      if (av === undefined) return 1;
      if (bv === undefined) return -1;
      return (av > bv ? 1 : -1) * (dir < 0 ? -1 : 1);
    }
    return 0;
  });
}

export function project(doc, fields) {
  if (!fields) return doc;
  const keys = Object.keys(fields);
  const include = keys.filter((k) => fields[k]);
  if (!include.length) return doc;
  return include.reduce((acc, key) => {
    acc[key] = getPath(doc, key);
    return acc;
  }, {});
}
