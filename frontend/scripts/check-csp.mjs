import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(frontendDir, 'dist');
const [html, nginxConfig] = await Promise.all([
  readFile(path.join(distDir, 'index.html'), 'utf8'),
  readFile(path.join(frontendDir, 'nginx.conf'), 'utf8'),
]);

const headerMatch = nginxConfig.match(
  /add_header\s+Content-Security-Policy\s+"([^"]+)"\s+always;/,
);
if (!headerMatch) {
  throw new Error('nginx.conf is missing an always-on Content-Security-Policy header');
}

const directives = new Map(
  headerMatch[1]
    .split(';')
    .map((directive) => directive.trim().split(/\s+/))
    .filter((tokens) => tokens[0])
    .map(([name, ...sources]) => [name, sources]),
);
const scriptSources = directives.get('script-src-elem')
  ?? directives.get('script-src')
  ?? directives.get('default-src')
  ?? [];
if (!scriptSources.includes("'self'")) {
  throw new Error("CSP script-src must allow same-origin scripts with 'self'");
}
if (scriptSources.includes("'unsafe-inline'")) {
  throw new Error("CSP script-src must not allow 'unsafe-inline'");
}

const pageUrl = new URL('https://slide.local/');
const document = new JSDOM(html, { url: pageUrl }).window.document;
const executableTypes = new Set([
  '',
  'module',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
]);
const scripts = [...document.querySelectorAll('script')].filter((script) =>
  executableTypes.has((script.getAttribute('type') ?? '').trim().toLowerCase()),
);

if (scripts.length === 0) {
  throw new Error('Production HTML contains no executable scripts');
}

for (const script of scripts) {
  const source = script.getAttribute('src');
  if (!source) {
    throw new Error('Production HTML contains an inline executable script blocked by CSP');
  }

  const scriptUrl = new URL(source, pageUrl);
  if (scriptUrl.origin !== pageUrl.origin) {
    throw new Error(`Production HTML references a script outside CSP self: ${source}`);
  }

  const outputPath = path.join(distDir, decodeURIComponent(scriptUrl.pathname).replace(/^\/+/, ''));
  await access(outputPath);
}

const themeScript = scripts.find((script) => script.getAttribute('src') === '/theme-init.js');
if (!themeScript || !document.head.contains(themeScript)) {
  throw new Error('Theme initialization must load from /theme-init.js in <head>');
}

console.log(`CSP check passed for ${scripts.length} production scripts.`);
