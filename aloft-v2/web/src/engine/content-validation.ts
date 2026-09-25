// Tiny schema checks for content JSON: every key present, every number in range, no stray
// keys (typos fail loudly). Keys starting with "$" are notes and are ignored.

export type Rule =
  | { kind: 'number'; min: number; max: number }
  | { kind: 'integer'; min: number; max: number }
  | { kind: 'boolean' }
  | { kind: 'string'; oneOf?: readonly string[]; pattern?: RegExp }
  | { kind: 'object'; shape: Shape }
  | { kind: 'array'; item: Rule; minLength: number; maxLength: number }
  | { kind: 'optional'; rule: Rule };
export type Shape = { readonly [key: string]: Rule };

export const num = (min: number, max: number): Rule => ({ kind: 'number', min, max });
export const int = (min: number, max: number): Rule => ({ kind: 'integer', min, max });
export const bool = (): Rule => ({ kind: 'boolean' });
export const str = (oneOf?: readonly string[]): Rule => (oneOf ? { kind: 'string', oneOf } : { kind: 'string' });
/** An sRGB hex colour, "#rrggbb". */
export const hexColour = (): Rule => ({ kind: 'string', pattern: /^#[0-9a-fA-F]{6}$/ });
export const obj = (shape: Shape): Rule => ({ kind: 'object', shape });
export const arr = (item: Rule, minLength = 0, maxLength = Number.MAX_SAFE_INTEGER): Rule => ({ kind: 'array', item, minLength, maxLength });
export const optional = (rule: Rule): Rule => ({ kind: 'optional', rule });

export class ContentError extends Error {}

function fail(path: string, message: string): never {
  throw new ContentError(`${path}: ${message}`);
}

export function check(value: unknown, rule: Rule, path: string): void {
  switch (rule.kind) {
    case 'optional':
      if (value !== undefined && value !== null) check(value, rule.rule, path);
      return;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, `expected a number, got ${JSON.stringify(value)}`);
      if (rule.kind === 'integer' && !Number.isInteger(value)) fail(path, `expected an integer, got ${value}`);
      if (value < rule.min || value > rule.max) fail(path, `${value} is outside [${rule.min}, ${rule.max}]`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') fail(path, `expected true/false, got ${JSON.stringify(value)}`);
      return;
    case 'string':
      if (typeof value !== 'string') fail(path, `expected a string, got ${JSON.stringify(value)}`);
      if (rule.oneOf && !rule.oneOf.includes(value)) fail(path, `"${value}" is not one of ${rule.oneOf.join(', ')}`);
      if (rule.pattern && !rule.pattern.test(value)) fail(path, `"${value}" does not match ${rule.pattern}`);
      return;
    case 'array':
      if (!Array.isArray(value)) fail(path, 'expected an array');
      if (value.length < rule.minLength || value.length > rule.maxLength) fail(path, `length ${value.length} is outside [${rule.minLength}, ${rule.maxLength}]`);
      value.forEach((item, i) => check(item, rule.item, `${path}[${i}]`));
      return;
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'expected an object');
      const record = value as Record<string, unknown>;
      for (const [key, child] of Object.entries(rule.shape)) {
        if (!(key in record) && child.kind !== 'optional') fail(`${path}.${key}`, 'missing');
        check(record[key], child, `${path}.${key}`);
      }
      for (const key of Object.keys(record)) {
        if (!key.startsWith('$') && !(key in rule.shape)) fail(`${path}.${key}`, 'unknown key (typo?)');
      }
      return;
    }
  }
}

/** Validate and return the value typed as T (the shape must describe T). */
export function validated<T>(value: unknown, shape: Shape, path: string): T {
  check(value, obj(shape), path);
  return value as T;
}
