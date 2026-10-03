#!/usr/bin/env node
'use strict';
// No dependencies. Default is read-only. Destination is deliberately not configurable.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const destination = path.join(root, 'github');
const args = process.argv.slice(2);
if (args.some(arg => !['--apply', '--help'].includes(arg))) throw Error('Only --apply and --help are supported');
if (args.includes('--help')) {
  console.log('node tools/export-github.cjs [--apply]\nDefault: audit and print plan; --apply: synchronize proven generated files and write audit/manifest. Unknown files and local edits are preserved.');
  process.exit(0);
}
const apply = args.includes('--apply');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stateName = '.export-manifest.json';
const reportName = 'EXPORT-AUDIT.json';
const editorial = new Set(['README.md', 'GITHUB-SETUP.md', '.gitignore', '.ignore', stateName, reportName]);
function safe(base, relative = '') {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => p === '..')) throw Error('Unsafe relative path');
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep)) throw Error('Path escapes root');
  // Check every ancestor, including junctions. Never follow links during reads/writes.
  let current = target;
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('Symlink/junction rejected');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return target;
}
safe(root); safe(destination);
if (!fs.existsSync(destination) || !fs.statSync(destination).isDirectory()) throw Error('Existing github directory required');
function excluded(rel) {
  const parts = rel.toLowerCase().split('/');
  const name = parts.at(-1);
  return parts.slice(0, -1).some(p => /^(node_modules|data|uploads|photos|dist|staging|coverage|bin|obj|cache|\.cache|\.slim|\.verification|\.git|github|secrets)$/.test(p) || /^(build|verify-build|test-check)/.test(p))
    || /^desktop\/(resources|backend)(\/|$)/i.test(rel)
    || /^(classroom_config\.h|classroom-config\.local\.json|credentials\.json|secrets?\.json|\.npmrc|\.env(?:\..*)?|compile_commands\.json|download-attempts\.json|evaluation\.json)$/i.test(name)
    || /\.(log|pid|tmp|cache|pem|key|p12|pfx|a|o|d|elf|bin|map|exe|dll|node|zip|7z|bak)$/i.test(name)
    || /(?:^|[.-])(local|secret|credentials)(?:[.-]|$)/i.test(name);
}
function allowed(rel) {
  if (excluded(rel)) return false;
  if (/^cloud-server\/(?:[^/]+\.(?:js|cjs|mjs|md)|package(?:-lock)?\.json)$/.test(rel)) return true;
  if (/^cloud-server\/(public|test)\//.test(rel)) return /\.(js|cjs|mjs|html|css|json|svg|png|jpg|woff2?|md)$/.test(rel);
  if (/^cloud-server\/handwriting\//.test(rel)) return /\.(js|cjs|mjs|json|md|onnx|tes|txt)$/.test(rel) || /\/(LICENSE|SHA256SUMS)$/.test(rel);
  if (/^firmware\/(max35_cloud_clicker|max35_cloud_clicker_display)\/[^/]+$/.test(rel)) return /\.(ino|h|cpp|md|example)$/.test(rel);
  if (/^firmware\/libraries\//.test(rel)) return /\.(h|hpp|c|cpp|ino|properties|md|txt|json)$/.test(rel) || /\/(LICENSE|COPYING)$/.test(rel);
  if (/^desktop\/(scripts|main|preload|ui|network|tests)\//.test(rel)) return /\.(cjs|mjs|js|cs|csproj|html|css|json|md|svg|png|ico)$/.test(rel);
  if (/^desktop\/[^/]+$/.test(rel)) return /(?:\.md|package(?:-lock)?\.json|\.gitignore)$/.test(rel);
  return /^launcher\/[^/]+\.(ps1|cmd|html|md)$/.test(rel) || rel === 'launcher/.gitignore';
}
function walk(base, rel = '', prune = () => false) {
  const result = [];
  for (const entry of fs.readdirSync(safe(base, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const item = rel ? `${rel}/${entry.name}` : entry.name;
    if (prune(item, entry.isDirectory())) continue;
    safe(base, item);
    if (entry.isDirectory()) result.push(...walk(base, item, prune));
    else if (entry.isFile()) result.push(item);
    else throw Error('Unsupported filesystem entry');
  }
  return result;
}
function read(base, rel) { return fs.readFileSync(safe(base, rel)); }
const sourceFiles = ['cloud-server', 'desktop', 'firmware', 'launcher'].flatMap(dir =>
  walk(root, dir, (rel, isDir) => isDir && excluded(rel)));
const desired = new Map(sourceFiles.filter(allowed).map(rel => [rel, read(root, rel)]));
// Also ship this exact tool so the export policy is reviewable.
desired.set('tools/export-github.cjs', read(root, 'tools/export-github.cjs'));
const existing = walk(destination, '', rel => rel === '.git');
const before = new Map(existing.map(rel => [rel, read(destination, rel)]));
const state = before.has(stateName) ? JSON.parse(before.get(stateName).toString('utf8')) : { version: 1, files: {} };
if (state.version !== 1 || !state.files || typeof state.files !== 'object') throw Error('Invalid export manifest');
for (const [rel, value] of Object.entries(state.files)) {
  safe(destination, rel);
  if (!/^[a-f0-9]{64}$/.test(value)) throw Error('Invalid manifest hash');
}
// Real config values stay in memory; neither values nor their hashes enter reports.
const sensitive = new Set();
const publicExamples = new Set(['local-mvp-device-token', 'local-mvp-teacher-token']);
const configPaths = sourceFiles.filter(rel => /(?:classroom_config\.h|classroom-config\.local\.json|\.env(?:\.[^/]*)?|credentials\.json|secrets?\.json)$/i.test(rel));
for (const entry of fs.readdirSync(root)) {
  if (/^(\.env(?:\..*)?|credentials\.json|secrets?\.json)$/i.test(entry) && fs.lstatSync(safe(root, entry)).isFile()) configPaths.push(entry);
}
function collect(value) {
  if (typeof value !== 'string' || value.length < 4 || publicExamples.has(value)) return;
  if (/^(?:YOUR[_ -]|CHANGE[_ -]?ME|REPLACE[_ -]|<|example)/i.test(value)) return;
  sensitive.add(value);
}
function configObject(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/password|passwd|token|secret|api[_-]?key|ssid|server[_-]?(?:url|base)/i.test(key)) collect(item);
    if (item && typeof item === 'object') configObject(item);
  }
}
for (const rel of configPaths) {
  const text = read(root, rel).toString('utf8');
  if (rel.endsWith('.json')) { try { configObject(JSON.parse(text)); } catch { throw Error(`Cannot audit config JSON: ${rel}`); } }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:#define\s+|(?:export\s+)?)([\w]+)\s*(?:=\s*|\s+)(.*)$/);
    if (!match || !/password|passwd|token|secret|api[_-]?key|ssid|server[_-]?(?:url|base)/i.test(match[1])) continue;
    const quoted = match[2].match(/^["'](.*?)["']/);
    collect(quoted ? quoted[1] : match[2].replace(/\s+#.*$/, '').trim());
  }
}
function findings(files) {
  const result = [];
  for (const [rel, bytes] of files) {
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    let count = 0;
    for (const value of sensitive) if (text.includes(value)) count++;
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) count++;
    if (count) result.push({ path: rel, matchedValues: count });
  }
  return result;
}
const actions = [], conflicts = [], unknown = [], managed = {};
for (const [rel, bytes] of desired) {
  const old = before.get(rel), nextHash = hash(bytes);
  if (!old) actions.push({ action: 'add', path: rel });
  else if (hash(old) !== nextHash) {
    if (state.files[rel] === hash(old)) actions.push({ action: 'update', path: rel });
    else { conflicts.push(rel); continue; }
  }
  managed[rel] = nextHash;
}
for (const [rel, bytes] of before) {
  if (desired.has(rel) || editorial.has(rel)) continue;
  const sourcePath = safe(root, rel);
  const identicalSource = fs.existsSync(sourcePath) && fs.lstatSync(sourcePath).isFile() && hash(read(root, rel)) === hash(bytes);
  if (state.files[rel] === hash(bytes) || (excluded(rel) && identicalSource)) actions.push({ action: 'remove', path: rel });
  else unknown.push(rel);
}
const projected = new Map(before);
for (const action of actions) {
  if (action.action === 'remove') projected.delete(action.path);
  else projected.set(action.path, desired.get(action.path));
}
const stats = files => ({ files: files.size, bytes: [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) });
const leaks = findings(projected);
const report = {
  schema: 1, mode: apply ? 'apply' : 'dry-run', timestamp: new Date().toISOString(),
  before: stats(before), projectedBeforeReportAndManifest: stats(projected),
  sourceAllowlist: stats(desired), actions, conflicts, preservedUnknown: unknown,
  configFilesScanned: configPaths.length, sensitiveValuesCollected: sensitive.size,
  existingSensitiveMatches: findings(before), projectedSensitiveMatches: leaks,
  excludedPathsRemaining: [...projected.keys()].filter(rel => excluded(rel)),
  scope: 'Source export only; no dependency installation, builds, services, COM, hardware validation or upload.'
};
console.log(JSON.stringify(report, null, 2));
if (apply) {
  if (leaks.length) throw Error('Sensitive matches remain; no files changed. Review reported paths without printing values.');
  // Revalidate the whole read snapshot before the first mutation to detect concurrent lanes.
  for (const [rel, bytes] of desired) if (hash(read(root, rel)) !== hash(bytes)) throw Error(`Source changed during audit: ${rel}; rerun`);
  const now = walk(destination, '', rel => rel === '.git');
  if (now.join('\n') !== existing.join('\n')) throw Error('Destination file set changed; rerun');
  for (const [rel, bytes] of before) if (hash(read(destination, rel)) !== hash(bytes)) throw Error(`Destination changed: ${rel}; rerun`);
  for (const action of actions) {
    const output = safe(destination, action.path);
    if (action.action === 'remove') fs.unlinkSync(output);
    else {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(safe(destination, action.path), desired.get(action.path));
    }
  }
  fs.writeFileSync(safe(destination, stateName), JSON.stringify({ version: 1, files: managed }, null, 2) + '\n');
  fs.writeFileSync(safe(destination, reportName), JSON.stringify(report, null, 2) + '\n');
  const finalFiles = walk(destination, '', rel => rel === '.git');
  console.log(JSON.stringify({ final: stats(new Map(finalFiles.map(rel => [rel, read(destination, rel)]))) }));
}
if (conflicts.length || leaks.length || report.excludedPathsRemaining.length || unknown.length) process.exitCode = 2;
