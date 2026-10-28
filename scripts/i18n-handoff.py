#!/usr/bin/env python3
"""Write i18n/HANDOFF.md: what the English-mode UI needs from the server side.

The fixed part (contract, findings) is HEAD below; the list of server strings that still reach the
screen in Korean — and that the web dictionary translates on arrival — comes from i18n/strings.json
(run scripts/i18n-extract.py first). Strings inside L(ko, en) are English at the source already and
are not listed; nor are files with their own English tables (EN_TABLES).

    python3 scripts/i18n-handoff.py
"""
import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EN_TABLES = {'server/lib/improve/demoProcess.js', 'server/lib/mining/catalog.js'}
HEAD = (ROOT / 'i18n' / 'HANDOFF.head.md').read_text(encoding='utf-8')


def main():
    d = json.loads((ROOT / 'i18n/strings.json').read_text(encoding='utf-8'))
    dict_path = ROOT / 'src/i18n/ko-en.json'
    en = json.loads(dict_path.read_text(encoding='utf-8')) if dict_path.exists() else {'exact': {}, 'patterns': []}
    pats = dict(en.get('patterns', []))
    by_file = defaultdict(list)
    for e in d['strings']:
        src = next((s for s in e['sources'] if s.startswith('server/')), None)
        if not src:
            continue
        f, _, line = src.rpartition(':')
        if f in EN_TABLES:
            continue
        english = en['exact'].get(e['text']) if e['kind'] == 'exact' else pats.get(e['text'])
        by_file[f].append((int(line), e['kind'], e['text'], english or '(dictionary)'))
    total = sum(len(v) for v in by_file.values())
    out = [HEAD.rstrip(), '', f'## Server strings still Korean at the source ({total}, by file)', '',
           'Each reaches a screen (card, notice, error, status) and is translated on arrival by the web',
           'dictionary today. Generating them with `L(ko, en)` (server/lib/lang.js) makes the stored text',
           'English too (messages and notifications are saved, and re-read later). The English column is',
           'the dictionary\'s — use it so the screens and the tutorial keep the same words.', '']
    for f in sorted(by_file, key=lambda f: -len(by_file[f])):
        out.append(f'### {f} ({len(by_file[f])})')
        out.append('')
        out.append('| line | Korean | English (dictionary) |')
        out.append('|---|---|---|')
        for line, kind, ko, eng in sorted(by_file[f]):
            cell = lambda s: s.replace('|', '\\|').replace('\n', '⏎')[:160]
            out.append(f'| {line} | {cell(ko)} | {cell(eng)} |')
        out.append('')
    (ROOT / 'i18n/HANDOFF.md').write_text('\n'.join(out) + '\n', encoding='utf-8')
    print(f'i18n/HANDOFF.md: {total} server strings in {len(by_file)} files')


if __name__ == '__main__':
    main()
