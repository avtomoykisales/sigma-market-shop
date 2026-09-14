#!/usr/bin/env python3
"""
Точечно накатывает MANUAL_OVERRIDES (из build-redirect-map.py) поверх УЖЕ
СУЩЕСТВУЮЩИХ avtomoyki-map.conf / redirect-map.csv — без обращения к живым
sitemap avtomoyki.kz (они недоступны с 2026-09-11/12, домен сам редиректит на нас,
поэтому build-redirect-map.py больше нельзя просто перезапускать целиком).

Использование: допиши новую пару в MANUAL_OVERRIDES в build-redirect-map.py, затем:
    python3 apply-overrides.py
"""
import re, os

MIGDIR = os.path.dirname(os.path.abspath(__file__))
CONF = os.path.join(MIGDIR, 'avtomoyki-map.conf')
CSV = os.path.join(MIGDIR, 'redirect-map.csv')
NEW = 'https://b2btech.kz'

base = []  # (old, new)
for line in open(CONF, encoding='utf-8'):
    m = re.match(r'\s+(\S+)\s+"([^"]*)";', line)
    if m and m.group(1) != 'default':
        base.append((m.group(1), m.group(2)))

notes = {}
for line in open(CSV, encoding='utf-8').read().splitlines()[1:]:
    if not line.strip():
        continue
    old_full, _, note = line.split(',')[:3]
    notes[re.sub(r'^https?://[^/]+', '', old_full)] = note

uniq = [(old, new, notes.get(old, '')) for old, new in base]

src = open(os.path.join(MIGDIR, 'build-redirect-map.py'), encoding='utf-8').read()
m = re.search(r'MANUAL_OVERRIDES\s*=\s*\{(.*?)\n\}', src, re.S)
ns = {}
exec('MANUAL_OVERRIDES = {' + m.group(1) + '\n}', ns)
MANUAL_OVERRIDES = ns['MANUAL_OVERRIDES']

by_old = {old: i for i, (old, _, _) in enumerate(uniq)}
changed = 0
for old, new in MANUAL_OVERRIDES.items():
    note = 'ручная правка (Евгений/проверено)'
    if old in by_old:
        i = by_old[old]
        if uniq[i][1] != new:
            uniq[i] = (old, new, note)
            changed += 1
    else:
        uniq.append((old, new, note))
        by_old[old] = len(uniq) - 1
        changed += 1

with open(CONF, 'w') as f:
    f.write('# avtomoyki.kz -> b2btech.kz  |  /etc/nginx/conf.d/avtomoyki-map.conf\n')
    f.write('map $uri $b2b_redirect {\n    default "";\n')
    for old, new, _ in uniq:
        f.write(f'    {old:<64} "{new}";\n')
    f.write('}\n')

with open(CSV, 'w') as f:
    f.write('Старый адрес,Новый адрес,Тип,Проверить\n')
    for old, new, note in uniq:
        chk = 'да' if ('раздел' in note and 'товар' in note) or 'без пары' in note else ''
        f.write(f'https://avtomoyki.kz{old},{NEW}{new},{note},{chk}\n')

print(f'Правил всего: {len(uniq)} (изменено/добавлено: {changed})')
