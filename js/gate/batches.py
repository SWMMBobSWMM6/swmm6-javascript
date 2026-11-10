#!/usr/bin/env python3
"""batches.py NAME ENGINE SET IDS DEADLINE - run one gate run of the JavaScript port as a series of gate.py calls that
stops in time: called by run_chunk.sh once it holds the corpus lock, with DEADLINE (epoch seconds) two hours after
run_chunk.sh was started less a margin, so that the whole command, its wait for the lock included, ends inside the
two hours a background command may take. Each call is

    nice -n 10 python3 gate/gate.py NAME ENGINE [--models models_extra.tsv --ref ref_outputs_extra] --ids BATCH
                                    -j 1 --timeout 1800 --prune --resume

on the next models of IDS not yet in gate/results/NAME.jsonl, as many as fit in about ten minutes by their estimated
times (js/gate/est_times.tsv: the TypeScript port's times); before each call the estimates times 1.5 (each at most
1830 s: gate.py stops a model at 1800 s) plus two minutes must end before DEADLINE (a model that would not fit waits for the next sitting, and if nothing fits the run stops).
When every model of IDS is in the .jsonl, one last call over all of IDS (with --resume: nothing is run again) writes
gate/results/NAME.json for the whole set. Exit status: 0 complete, 3 stopped for time (run_chunk.sh with --resume
continues it), anything else gate.py's failure.
Written by Claude (Anthropic) for Robert Dickinson's SWMM6 ports; see js/README.md."""
import json, os, subprocess, sys, tempfile, time

name, engine, which, ids_file, deadline = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], float(sys.argv[5])
HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(HERE, '..', '..', 'gate')
est = {}
for l in open(os.path.join(HERE, 'est_times.tsv')):
    if l.strip() and not l.startswith('#'):
        i, s = l.split('\t'); est[i] = float(s)
ids = open(ids_file).read().split()
extra = ['--models', 'models_extra.tsv', '--ref', 'ref_outputs_extra'] if which == 'extra' else []
jl = os.path.join(GATE, 'results', name + '.jsonl')


def done():
    d = set()
    if os.path.exists(jl):
        for l in open(jl):
            if l.strip():
                d.add(json.loads(l)['id'])
    return d


def gate(id_path):
    cmd = ['nice', '-n', '10', 'python3', 'gate.py', name, engine] + extra + ['--ids', id_path, '-j', '1', '--timeout', '1800',
                                                                             '--prune', '--resume']
    print('%s  %s' % (time.strftime('%Y-%m-%dT%H:%M:%S'), ' '.join(cmd)), flush=True)
    return subprocess.call(cmd, cwd=GATE)


while True:
    left = [i for i in ids if i not in done()]
    if not left:
        break
    batch, t = [], 0.0
    for i in left:
        e = est.get(i, 60.0)
        if batch and t + e > 600:
            break
        batch.append(i); t += e
    need = sum(min(1.5 * est.get(i, 60.0), 1830.0) for i in batch) + 120     # no model runs past gate.py's 1800 s
    if time.time() + need > deadline:
        print('%s  stopping for time: %d models left, the next batch (%d, about %.0f s) would end after the deadline'
              % (time.strftime('%Y-%m-%dT%H:%M:%S'), len(left), len(batch), t), flush=True)
        sys.exit(3)
    with tempfile.NamedTemporaryFile('w', dir=os.environ.get('TMPDIR', '/dev/shm'), prefix=name + '_', suffix='.txt', delete=False) as f:
        f.write('\n'.join(batch) + '\n')
    rc = gate(f.name)
    os.unlink(f.name)
    if rc != 0:
        sys.exit(rc)
sys.exit(gate(os.path.abspath(ids_file)))
