// A part of a path that names git's own data in a work tree, the way git itself recognises it (its own checks for NTFS and HFS+):
// `.git` in any case with trailing dots or spaces (`.GIT`, `.git.`, `.git `), its short name `git~1`, either with a `:` stream suffix
// (`.git::$INDEX_ALLOCATION`), and with the characters HFS+ ignores in a name taken out first. A document path never has one —
// folders/service.js safeRel (uploads, removals, reference slots) and workroom.js inside (the workroom's reads and writes) refuse it.
const IGNORED_IN_NAMES = /[‌-‏‪-‮⁪-⁯﻿]/g
const DOTGIT = /^(\.git[.\s]*|git~1)(:.*)?$/i
export const gitPart = (rel) => String(rel || '').split(/[\\/]+/).some((seg) => DOTGIT.test(seg.replace(IGNORED_IN_NAMES, '').trim()))
