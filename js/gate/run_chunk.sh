#!/bin/bash
# run_chunk.sh NAME SET [IDS_FILE|-] [ENGINE] [--resume]
# One gate run of the JavaScript port, on the 480 corpus models (SET=corpus) or the 452 extra decks (SET=extra), run by
# batches.py as a series of
#   python3 gate/gate.py NAME ENGINE [--models models_extra.tsv --ref ref_outputs_extra] --ids BATCH -j 1 --timeout 1800 --prune --resume
# inside flock on the shared corpus lock (waiting up to 6600 s for it), niced, with TMPDIR and the results folder in
# /dev/shm (SWMM5 lessons/22), ENGINE defaulting to this port's runswmm6_saves.sh (which backs up and restores the files
# a deck SAVEs). batches.py stops before the command's two hours (queue included) are up; run again with --resume to
# go on. Afterwards the outputs of any failing model are copied to gate/results/NAME on disk (evidence) and the memory
# copy removed; gate/results/NAME.json and .jsonl stay where gate.py writes them, and a copy of the JSON and of the log
# go to js/results/. The queue, start and end times go to js/gate/NAME_times.txt.
# Copied from groovy/gate/run_chunk.sh; the batches and the deadline are new.
# Written by Claude (Anthropic) for Robert Dickinson's SWMM6 ports; see ../README.md.
set -u
T0=$(date +%s)
NAME=$1; SET=$2; IDS=${3:--}; RESUME=""
K=$(cd "$(dirname "$0")/.." && pwd); ROOT=$(cd "$K/.." && pwd)
ENGINE=${4:-$K/runswmm6_saves.sh}
[ "${5:-}" = --resume ] && RESUME=1
LOCK=${SWMM_GATE_LOCK:-${TMPDIR:-/tmp}/swmm6-gate.lock}  # one corpus run at a time
if [ "$IDS" = - ]; then
	IDS=/dev/shm/${NAME}_all_ids.txt
	if [ "$SET" = extra ]; then cut -f1 "$ROOT/gate/models_extra.tsv"; else cut -f1 "$ROOT/gate/models_all.tsv"; fi > "$IDS"
else
	IDS="$(cd "$(dirname "$IDS")" && pwd)/$(basename "$IDS")"
fi
DEADLINE=$(( T0 + 7200 - 240 ))
cd "$ROOT/gate"
[ -z "$RESUME" ] && rm -f "results/$NAME.jsonl" "results/$NAME.json"
M=/dev/shm/gate_$NAME
mkdir -p "$M"
if [ -L "results/$NAME" ]; then rm "results/$NAME"; elif [ -d "results/$NAME" ]; then cp -a "results/$NAME"/. "$M"/ 2>/dev/null; rm -rf "results/$NAME"; fi
ln -s "$M" "results/$NAME"
echo "queued $(date -Is)" >> "$K/gate/${NAME}_times.txt"
TMPDIR=/dev/shm flock -w 6600 "$LOCK" bash -c "echo \"started \$(date -Is)\" >> '$K/gate/${NAME}_times.txt'; \
  python3 '$K/gate/batches.py' '$NAME' '$ENGINE' '$SET' '$IDS' $DEADLINE" >> "$K/gate/${NAME}_run.txt" 2>&1
rc=$?
echo "ended $(date -Is) rc=$rc" >> "$K/gate/${NAME}_times.txt"
rm "results/$NAME"
mkdir -p "results/$NAME"
cp -a "$M"/. "results/$NAME"/ 2>/dev/null
rmdir "results/$NAME" 2>/dev/null
rm -rf "$M"
if [ $rc = 0 ] && [ -f "results/$NAME.json" ]; then cp "results/$NAME.json" "$K/results/$NAME.json"; fi
cp "$K/gate/${NAME}_run.txt" "$K/results/${NAME}_run.txt"
tail -4 "$K/gate/${NAME}_run.txt"
exit $rc
