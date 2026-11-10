#!/usr/bin/env python3
"""summarize.py NAME... - for each gate run of the JavaScript port: models, status counts, the wall time between the
start and end lines of js/gate/NAME_times.txt (minus nothing: the gate's own time, the lock wait excluded), the sum and
median of the per-model times gate.py records, the slowest model, and every model that did not pass with its first
difference. Reads gate/results/NAME.json (or the .jsonl while a run is going).
Written by Claude (Anthropic) for Robert Dickinson's SWMM6 ports; see ../README.md."""
import json, os, statistics, sys, datetime
HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.join(HERE, '..', '..', 'gate', 'results')
for name in sys.argv[1:]:
    p = os.path.join(R, name + '.json')
    if os.path.exists(p):
        rs = json.load(open(p)); src = 'json'
    else:
        rs = [json.loads(l) for l in open(os.path.join(R, name + '.jsonl')) if l.strip()]; src = 'jsonl (running)'
    from collections import Counter
    c = Counter(r['status'] for r in rs)
    secs = [r['sec'] for r in rs]
    wall = 0.0
    tf = os.path.join(HERE, name + '_times.txt')
    if os.path.exists(tf):
        st = None
        for l in open(tf):
            w = l.split()
            if w[0] == 'started': st = datetime.datetime.fromisoformat(w[1])
            if w[0] == 'ended' and st: wall += (datetime.datetime.fromisoformat(w[1]) - st).total_seconds(); st = None
    slow = max(rs, key=lambda r: r['sec'])
    print('%s: %d models, %s (%s); wall %.1f min under the lock; per-model sum %.0f s, median %.2f s; slowest %s %.0f s'
          % (name, len(rs), ', '.join('%s %d' % kv for kv in c.most_common()), src, wall / 60, sum(secs),
             statistics.median(secs), os.path.basename(slow['path']), slow['sec']))
    for r in rs:
        if r['status'] != 'PASS':
            print('   %s %s %s %s' % (r['status'], r['id'], r['path'], r['first_rpt_diff'] or r['stderr'][:200]))
