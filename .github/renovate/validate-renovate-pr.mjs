#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ignoredTestDirectories = new Set([
  '.git', '.gradle', '.mvn', '.pytest_cache', '.venv', 'build', 'dist',
  'node_modules', 'target', 'venv'
]);

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

export function sanitizedTestEnvironment(environment = process.env) {
  const sanitized = { ...environment, CI: 'true' };
  for (const name of [
    'RENOVATE_TOKEN', 'GITHUB_TOKEN', 'GITHUB_STATUS_TOKEN', 'GIT_ASKPASS',
    'GIT_PASSWORD', 'GIT_USERNAME', 'SSH_ASKPASS'
  ]) {
    delete sanitized[name];
  }
  return sanitized;
}

function withinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function projectDirectory(root, scope) {
  if (!scope || typeof scope !== 'object') throw new Error('Validation plan has no scope');
  if (typeof scope.directory !== 'string' || typeof scope.manifest !== 'string') {
    throw new Error('Validation plan contains malformed paths');
  }
  const directory = path.resolve(root, scope.directory);
  const manifest = path.resolve(root, scope.manifest);
  if (!withinRoot(root, directory) || !withinRoot(root, manifest) ||
      path.dirname(manifest) !== directory || !fs.existsSync(manifest)) {
    throw new Error(`Unsafe or missing validation manifest: ${scope.manifest}`);
  }
  return { directory, manifest };
}

function run(command, args, cwd, label, environment) {
  console.log(`[Jenkins PR validation] ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} exited with status ${result.status}`);
}

function findNodeInstallRoot(root, target) {
  let cursor = target;
  while (withinRoot(root, cursor)) {
    if (fs.existsSync(path.join(cursor, 'pnpm-lock.yaml'))) return { directory: cursor, manager: 'pnpm' };
    if (fs.existsSync(path.join(cursor, 'yarn.lock'))) return { directory: cursor, manager: 'yarn' };
    if (fs.existsSync(path.join(cursor, 'package-lock.json')) ||
        fs.existsSync(path.join(cursor, 'npm-shrinkwrap.json'))) {
      return { directory: cursor, manager: 'npm', locked: true };
    }
    if (cursor === root) break;
    cursor = path.dirname(cursor);
  }
  return { directory: target, manager: 'npm', locked: false };
}

function hasPythonTests(directory, depth = 0) {
  if (depth > 3) return false;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !ignoredTestDirectories.has(entry.name) &&
        hasPythonTests(path.join(directory, entry.name), depth + 1)) return true;
    if (entry.isFile() && (/^test_.*\.py$/i.test(entry.name) || /_test\.py$/i.test(entry.name))) return true;
  }
  return false;
}

function validateNode(root, scope, directory, environment) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const install = findNodeInstallRoot(root, directory);
  if (install.manager === 'pnpm') {
    run('corepack', ['enable'], install.directory, 'enable Corepack for pnpm', environment);
    run('pnpm', ['install', '--frozen-lockfile'], install.directory, 'install Node dependencies with pnpm', environment);
    if (packageJson.scripts?.test) run('pnpm', ['test'], directory, 'run Node tests with pnpm', environment);
  } else if (install.manager === 'yarn') {
    run('corepack', ['enable'], install.directory, 'enable Corepack for Yarn', environment);
    run('yarn', ['install', '--frozen-lockfile'], install.directory, 'install Node dependencies with Yarn', environment);
    if (packageJson.scripts?.test) run('yarn', ['test'], directory, 'run Node tests with Yarn', environment);
  } else {
    run('npm', [install.locked ? 'ci' : 'install', '--silent'], install.directory, 'install Node dependencies with npm', environment);
    if (packageJson.scripts?.test) run('npm', ['test', '--silent'], directory, 'run Node tests with npm', environment);
  }
}

function validatePython(scope, root, directory, environment) {
  const pythonBinary = process.env.PYTHON_BINARY || 'python3';
  if (scope.language === 'poetry') {
    run(pythonBinary, ['-m', 'pip', 'install', '--disable-pip-version-check', 'poetry'], directory, 'install Poetry', environment);
    run('poetry', ['install', '--no-interaction'], directory, 'install Poetry dependencies', environment);
    if (hasPythonTests(directory)) run('poetry', ['run', 'pytest', '-q'], directory, 'run Poetry tests', environment);
    return;
  }
  if (scope.language === 'pipenv') {
    run(pythonBinary, ['-m', 'pip', 'install', '--disable-pip-version-check', 'pipenv'], directory, 'install Pipenv', environment);
    run('pipenv', ['install', '--dev'], directory, 'install Pipenv dependencies', environment);
    if (hasPythonTests(directory)) run('pipenv', ['run', 'pytest', '-q'], directory, 'run Pipenv tests', environment);
    return;
  }

  const virtualEnvironment = path.join(root, '.jenkins-python');
  const virtualPython = process.platform === 'win32'
    ? path.join(virtualEnvironment, 'Scripts', 'python.exe')
    : path.join(virtualEnvironment, 'bin', 'python');
  fs.rmSync(virtualEnvironment, { recursive: true, force: true });
  run(pythonBinary, ['-m', 'venv', virtualEnvironment], directory, 'create Python virtual environment', environment);
  run(virtualPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', scope.manifestName], directory, 'install Python dependencies', environment);
  if (hasPythonTests(directory)) run(virtualPython, ['-m', 'pytest', '-q'], directory, 'run Python tests', environment);
}

export function validateScope(scope, root = process.cwd()) {
  const repositoryRoot = path.resolve(root);
  const { directory, manifest } = projectDirectory(repositoryRoot, scope);
  const safeScope = { ...scope, manifestName: path.basename(manifest) };
  const environment = sanitizedTestEnvironment();

  if (safeScope.language === 'node') {
    validateNode(repositoryRoot, safeScope, directory, environment);
  } else if (safeScope.language === 'maven') {
    run('mvn', ['-B', '-f', safeScope.manifestName, 'test'], directory, 'run Maven tests', environment);
  } else if (safeScope.language === 'gradle') {
    const nestedWrapper = path.join(directory, 'gradlew');
    const rootWrapper = path.join(repositoryRoot, 'gradlew');
    const wrapper = fs.existsSync(nestedWrapper) ? nestedWrapper : rootWrapper;
    if (!fs.existsSync(wrapper)) throw new Error('No Gradle wrapper found in the project or repository root');
    run('bash', [wrapper, '-p', directory, '--no-daemon', 'test'], directory, 'run Gradle tests', environment);
  } else if (['poetry', 'pipenv', 'pip'].includes(safeScope.language)) {
    validatePython(safeScope, repositoryRoot, directory, environment);
  } else {
    throw new Error(`Unsupported validation language: ${safeScope.language}`);
  }

  console.log(`RENOVATE_PR_VALIDATION_OK language=${safeScope.language} manifest=${safeScope.manifest}`);
}

function main() {
  const planFile = option('--plan');
  if (!planFile) throw new Error('--plan is required');
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  if (!Array.isArray(plan.include)) throw new Error('Validation plan must contain an include array');
  if (plan.include.length === 0) {
    console.log('RENOVATE_PR_VALIDATION_OK no-buildable-manifest');
    return;
  }
  if (plan.include.length !== 1) throw new Error('Validation plan must contain exactly one project');
  validateScope(plan.include[0]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
