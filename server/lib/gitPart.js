// A part of a path that names git's own data in a work tree: `.git` in any case, with trailing dots or around spaces (`.GIT`,
// `.git.`, `.git `). A document path never has one — folders/service.js safeRel (uploads, removals, reference slots) and
// workroom.js inside (the workroom's reads and writes) refuse it.
export const gitPart = (rel) => String(rel || '').split(/[\\/]+/).some((seg) => /^\.git\.*$/i.test(seg.trim()))
