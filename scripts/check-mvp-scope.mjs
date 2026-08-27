import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const forbiddenDependencies = [
  'neo4j-driver',
  '@langchain/',
  'openai',
  'kafkajs',
  '@octokit/',
  'simple-git',
];
const forbiddenRuntimeTerms = ['clipboard.read', 'getDisplayMedia', 'MediaRecorder'];
const textExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.toml', '.rs']);

async function collect(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'target', '.git', '.codex', 'openspec'].includes(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await collect(path)));
    else if (textExtensions.has(extname(entry.name))) output.push(path);
  }
  return output;
}

const files = await collect(root);
const violations = [];
for (const file of files) {
  if (file.endsWith(join('scripts', 'check-mvp-scope.mjs'))) continue;
  const content = await readFile(file, 'utf8');
  for (const term of [...forbiddenDependencies, ...forbiddenRuntimeTerms]) {
    if (content.includes(term)) violations.push(`${relative(root, file)}: ${term}`);
  }
}

if (violations.length > 0) {
  console.error(`MVP scope violations:\n${violations.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('MVP scope check passed.');
}
