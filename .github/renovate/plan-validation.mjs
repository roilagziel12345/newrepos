#!/usr/bin/env node

import fs from 'node:fs';
import { parseNameStatus, planValidation } from './scope.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const githubOutput = option('--github-output');
const jsonOutput = option('--json-output');
if (!githubOutput && !jsonOutput) {
  throw new Error('--github-output or --json-output is required');
}

let changedFiles = [];
if (!process.argv.includes('--empty')) {
  const changedFilesJson = option('--changed-files-json');
  const diffFile = option('--git-diff');
  if (changedFilesJson) {
    changedFiles = JSON.parse(fs.readFileSync(changedFilesJson, 'utf8'));
  } else if (diffFile) {
    changedFiles = parseNameStatus(fs.readFileSync(diffFile));
  } else {
    throw new Error('--changed-files-json, --git-diff, or --empty is required');
  }
}

const matrix = planValidation(changedFiles);
const scope = matrix.include[0];
if (githubOutput) {
  fs.appendFileSync(githubOutput, `matrix=${JSON.stringify(matrix)}\n`, 'utf8');
  fs.appendFileSync(githubOutput, `has_build=${scope ? 'true' : 'false'}\n`, 'utf8');
  fs.appendFileSync(
    githubOutput,
    `summary=${scope ? `${scope.language}:${scope.manifest}` : 'no-buildable-manifest'}\n`,
    'utf8'
  );
}
if (jsonOutput) fs.writeFileSync(jsonOutput, `${JSON.stringify(matrix)}\n`, 'utf8');

console.log(scope
  ? `Validation scope: ${scope.language} in ${scope.directory} (${scope.manifest})`
  : 'No buildable manifest changed');
