/**
 * The one rule for a name that becomes part of a path inside a container.
 *
 * Docker's archive extraction keeps a tar inside its destination directory,
 * but within that directory it resolves ".." like any filesystem would: a
 * tar entry "FactoryGame/Mods/../x" lands in FactoryGame, one level up from
 * where the mod was meant to go. Measured, not assumed -- see the security
 * review that added this file. So a directory or file name derived from
 * anything a person typed, uploaded or fetched has to be a single plain
 * segment, and the segments "." and ".." are not names at all.
 */

export class PathError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Reduces a name to one safe path segment, or refuses it.
 *
 * Refuses rather than repairs when nothing usable is left: quietly turning
 * "..zip" into "mod" would hide that the operator's input was not what they
 * thought, and the mod would then be impossible to find by its name later.
 */
export function safeSegment(raw: string, what = 'name'): string {
  const cleaned = raw
    .trim()
    // Slashes would make one name two segments; a hyphen keeps "Author/Mod"
    // readable as one.
    .replace(/[/\\]/g, '-')
    .replace(/[\0-\x1f\x7f]/g, '')
    .replace(/[^A-Za-z0-9._+ -]/g, '_')
    .slice(0, 96);

  // At least one letter or digit. This subsumes the dot-only case ("." and
  // "..") and also refuses names that are nothing but punctuation -- "/" or
  // "../.." reduce to "-" and "..-..", which are harmless to Docker but are
  // directories nobody would ever find by name again.
  if (!/[A-Za-z0-9]/.test(cleaned)) {
    throw new PathError(`That ${what} leaves nothing usable: give it a real name.`);
  }
  return cleaned;
}

/**
 * Checks a relative path this portal is about to hand to Docker, segment by
 * segment. A last line of defence for the case where every earlier check was
 * bypassed or forgotten -- which, since a path is assembled from several
 * inputs in several files, is the case worth planning for.
 */
export function assertRelativePath(path: string, what = 'path'): void {
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    throw new PathError(`Refusing an absolute or malformed ${what}: ${path}`);
  }
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new PathError(`Refusing a ${what} with an empty or dot segment: ${path}`);
    }
  }
}
