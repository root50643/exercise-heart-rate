import { copyFile, lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entryFiles = ['index.html', '運動心率.html', 'exercise-machine.jpg'];
const isAsset = (name) => ['.js', '.css'].includes(extname(name).toLowerCase())
  || (extname(name).toLowerCase() === '.md' && /license/i.test(basename(name)));

/** Create the public static artifact. Never publish the entire source directory. */
export async function buildSite(directory = projectRoot) {
  const root = await realpath(directory);
  const output = resolve(root, 'dist');
  if (dirname(output) !== root || basename(output) !== 'dist') throw new Error('Unsafe output directory.');
  const files = [...entryFiles];
  const walk = async (folder) => {
    for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const name = join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Asset symlinks are not supported: ${name}`);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile() && isAsset(entry.name)) files.push(name);
    }
  };
  await walk('assets');
  // Validate every input and the output before replacing a previous artifact.
  for (const name of files) {
    const input = join(root, name);
    const info = await lstat(input);
    const location = relative(root, await realpath(input));
    if (!info.isFile() || info.isSymbolicLink() || isAbsolute(location)
      || location === '..' || location.startsWith(`..${sep}`)) {
      throw new Error(`Unsafe build input: ${name}`);
    }
  }
  try {
    const existing = await lstat(output);
    if (!existing.isDirectory() || existing.isSymbolicLink() || await realpath(output) !== output) {
      throw new Error('dist must be a real directory inside the project.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const name of files) {
    const destination = join(output, name);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, name), destination);
  }
  await writeFile(join(output, '.nojekyll'), '');
  return [...files.map((name) => name.split(sep).join('/')), '.nojekyll'].sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await buildSite();
  console.log(`Built ${files.length} public files in dist/.`);
}
