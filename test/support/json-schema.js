// A small draft-07 validator covering the keywords the generated Codex
// app-server schema uses. Tests use it to hold the adapter and the fake
// app-server to the protocol of the installed harness.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const typeOf = (value) => value === null ? 'null' : Array.isArray(value) ? 'array'
  : Number.isInteger(value) ? 'integer' : typeof value;
const matchesType = (value, type) => type === typeOf(value) || (type === 'number' && typeof value === 'number');

export function validator(root) {
  const resolve = (ref) => ref.replace(/^#\//, '').split('/').reduce((node, key) => node?.[key], root)
    ?? (() => { throw new Error(`Unresolved schema reference ${ref}`); })();
  function errors(schema, value, at) {
    if (schema === true || schema === undefined) return [];
    if (schema === false) return [`${at}: not allowed`];
    if (schema.$ref) return errors(resolve(schema.$ref), value, at);
    const found = [];
    if (schema.type) {
      const types = [schema.type].flat();
      if (!types.some((type) => matchesType(value, type))) return [`${at}: expected ${types.join('|')}, got ${typeOf(value)}`];
    }
    if (schema.enum && !schema.enum.some((option) => option === value)) found.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
    if ('const' in schema && schema.const !== value) found.push(`${at}: expected ${JSON.stringify(schema.const)}`);
    for (const part of schema.allOf ?? []) found.push(...errors(part, value, at));
    if (schema.anyOf && !schema.anyOf.some((part) => !errors(part, value, at).length)) found.push(`${at}: matches no anyOf branch`);
    if (schema.oneOf) {
      const matches = schema.oneOf.filter((part) => !errors(part, value, at).length).length;
      if (matches !== 1) {
        // Report the closest branch so a protocol mismatch is diagnosable.
        const nearest = schema.oneOf.map((part) => errors(part, value, at)).sort((a, b) => a.length - b.length)[0];
        found.push(`${at}: matches ${matches} oneOf branches${matches ? '' : `; nearest: ${nearest.slice(0, 3).join('; ')}`}`);
      }
    }
    if (typeOf(value) === 'object') {
      for (const key of schema.required ?? []) if (!(key in value)) found.push(`${at}: missing ${key}`);
      for (const [key, item] of Object.entries(value)) {
        if (schema.properties && key in schema.properties) found.push(...errors(schema.properties[key], item, `${at}.${key}`));
        else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
          found.push(...errors(schema.additionalProperties, item, `${at}.${key}`));
        }
      }
    }
    if (Array.isArray(value) && schema.items) value.forEach((item, index) => found.push(...errors(schema.items, item, `${at}[${index}]`)));
    return found;
  }
  return {
    errors: (schema, value) => errors(schema, value, '$'),
    definition: (name) => resolve(`#/definitions/${name}`),
  };
}

let cached;
// Generates the experimental protocol schema from the installed Codex once per
// test process. Returns null when Codex is not installed.
export function installedCodexSchema(command = 'codex') {
  if (cached !== undefined) return cached;
  const out = mkdtempSync(path.join(tmpdir(), 'frameboard-codex-schema-'));
  try {
    execFileSync(command, ['app-server', 'generate-json-schema', '--experimental', '--out', out], { stdio: 'ignore', timeout: 30000 });
    const load = (name) => JSON.parse(readFileSync(path.join(out, name), 'utf8'));
    const version = execFileSync(command, ['--version'], { encoding: 'utf8' }).trim();
    cached = { version, out, files: Object.fromEntries(['ClientRequest', 'ClientNotification', 'ServerRequest', 'ServerNotification'].map((name) => [name, load(`${name}.json`)])), v2: load('codex_app_server_protocol.v2.schemas.json'), load };
  } catch {
    rmSync(out, { recursive: true, force: true });
    cached = null;
  }
  return cached;
}
