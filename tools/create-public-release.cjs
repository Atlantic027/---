#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'github-release');
const rootFiles = new Set(['README.md', 'GITHUB-SETUP.md', '.gitignore', '.ignore']);
const publicDefaults = new Set(['local-mvp-device-token', 'local-mvp-teacher-token']);

function excluded(relative) {
  const parts = relative.toLowerCase().split('/');
  const name = parts.at(-1);
  return parts.some(part => /^(node_modules|data|uploads|photos|dist|staging|coverage|bin|obj|cache|\.cache|\.slim|\.verification|\.git|github-release|secrets)$/.test(part) || /^(build|verify-build|test-check)/.test(part))
    || /^desktop\/(resources|backend)(\/|$)/i.test(relative)
    || /^(classroom_config\.h|classroom-config\.local\.json|credentials\.json|secrets?\.json|\.npmrc|\.env(?:\..*)?|compile_commands\.json|download-attempts\.json|evaluation\.json)$/i.test(name)
    || /\.(log|pid|tmp|cache|pem|key|p12|pfx|a|o|d|elf|bin|map|exe|dll|node|zip|7z|bak)$/i.test(name)
    || /(?:^|[.-])(local|secret|credentials)(?:[.-]|$)/i.test(name);
}

function allowed(relative) {
  if (excluded(relative)) return false;
  if (rootFiles.has(relative)) return true;
  if (/^cloud-server\/(?:[^/]+\.(?:js|cjs|mjs|md)|package(?:-lock)?\.json)$/.test(relative)) return true;
  if (/^cloud-server\/(public|test)\//.test(relative)) return /\.(js|cjs|mjs|html|css|json|svg|png|jpg|woff2?|md)$/.test(relative);
  if (/^cloud-server\/handwriting\//.test(relative)) return /\.(js|cjs|mjs|json|md|onnx|tes|txt)$/.test(relative) || /\/(LICENSE|SHA256SUMS)$/.test(relative);
  if (/^firmware\/(max35_cloud_clicker|max35_cloud_clicker_display)\/[^/]+$/.test(relative)) return /\.(ino|h|cpp|md|example)$/.test(relative);
  if (/^firmware\/libraries\//.test(relative)) return /\.(h|hpp|c|cpp|ino|properties|md|txt|json)$/.test(relative) || /\/(LICENSE|COPYING)$/.test(relative);
  if (/^desktop\/(scripts|main|preload|ui|network|tests)\//.test(relative)) return /\.(cjs|mjs|js|cs|csproj|html|css|json|md|svg|png|ico)$/.test(relative);
  if (/^desktop\/[^/]+$/.test(relative)) return /(?:\.md|package(?:-lock)?\.json|\.gitignore)$/.test(relative);
  if (/^models\//.test(relative)) return /\.(scad|md)$/.test(relative);
  if (/^launcher\/[^/]+\.(ps1|cmd|html|md)$/.test(relative) || relative === 'launcher/.gitignore') return true;
  return /^tools\/[^/]+\.cjs$/.test(relative);
}

function walk(base, relative = '') {
  const directory = path.join(base, relative);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const item = relative ? `${relative}/${entry.name}` : entry.name;
    if (excluded(item)) return [];
    if (entry.isDirectory()) return walk(base, item);
    if (!entry.isFile()) throw new Error(`Unsupported filesystem entry: ${item}`);
    return [item];
  });
}

function collectConfigValues() {
  const values = new Set();
  function configFiles(relative = '') {
    return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
      const item = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return /^(node_modules|github-release|\.git)$/i.test(entry.name) ? [] : configFiles(item);
      return entry.isFile() && /(?:classroom_config\.h|classroom-config\.local\.json|\.env(?:\..*)?|credentials\.json|secrets?\.json)$/i.test(entry.name) ? [item] : [];
    });
  }
  for (const relative of configFiles()) {
    const text = fs.readFileSync(path.join(root, relative), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:#define\s+|(?:export\s+)?)([\w]+)\s*(?:=\s*|\s+)(.*)$/);
      if (!match || !/password|passwd|token|secret|api[_-]?key|ssid|server[_-]?(?:url|base)/i.test(match[1])) continue;
      const quoted = match[2].match(/^["'](.*?)["']/);
      const value = (quoted ? quoted[1] : match[2].replace(/\s+#.*$/, '').trim());
      if (value.length >= 4 && !publicDefaults.has(value) && !/^(?:your|replace|example|change)/i.test(value)) values.add(value);
    }
  }
  return values;
}

fs.rmSync(output, { recursive: true, force: true });
const sensitive = collectConfigValues();
const files = walk(root).filter(allowed);
const leaks = [];
for (const relative of files) {
  const source = path.join(root, relative);
  const bytes = fs.readFileSync(source);
  if (!bytes.includes(0)) {
    const text = bytes.toString('utf8');
    if ([...sensitive].some(value => text.includes(value)) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) leaks.push(relative);
  }
}
if (leaks.length) throw new Error(`Sensitive values found in public files: ${leaks.join(', ')}`);

for (const relative of files) {
  const destination = path.join(output, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, relative), destination);
}
const manifest = files.sort().map(relative => ({ path: relative, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(output, relative))).digest('hex') }));
fs.writeFileSync(path.join(output, 'PUBLIC-RELEASE-AUDIT.json'), JSON.stringify({ generatedAt: new Date().toISOString(), files: manifest.length, sensitiveValuesScanned: sensitive.size, manifest }, null, 2) + '\n');
console.log(`Created ${output} with ${files.length} public files; scanned ${sensitive.size} local sensitive values.`);
