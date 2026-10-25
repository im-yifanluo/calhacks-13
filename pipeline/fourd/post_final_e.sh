#!/usr/bin/env bash
# Final run e (v59, current clip, refined poses, exposure-normalized): wait for training, then spz-only export.
A=/workspace/4dgs/A
until grep -q "train v59e/e done" /workspace/logs/4dgs.log; do sleep 10; done
FREE=$(df --output=avail -BG /workspace | tail -1 | tr -dc 0-9)
if [ "$FREE" -lt 18 ]; then echo "$(date -u +%FT%TZ) [4dgs] STOP: only ${FREE} GB free, not exporting" >> /workspace/logs/4dgs.log; exit 1; fi
export FOURD_DYN_FLAG=1
bash $A/post.sh $A/runs/v59e/e $A/configs/v59d.py $A/data/v59e /workspace/work/v59 $A/out/v59e_e 0 --do eval,export --keep_ply 0 > $A/out/v59e_e.log 2>&1
source /workspace/memory-replay/pipeline/runpod/env.sh; use world; source /workspace/envs/4dgs/bin/activate; export CUDA_VISIBLE_DEVICES=0
cd $A/4DGaussians
python $A/motion.py -m $A/runs/v59e/e --configs $A/configs/v59d.py --data $A/data/v59e --work /workspace/work/v59 --out $A/out/v59e_e/motion.json > $A/out/v59e_e_motion.log 2>&1
python $A/compare.py -m $A/runs/v59e/e --configs $A/configs/v59d.py --work /workspace/work/v59 --shots $A/shots/v59 --out $A/out/v59e_e/compare_e.jpg --name "run e" --bg 0 --exposure /workspace/work/v59/world/exposure.json > $A/out/v59e_e_compare.log 2>&1
echo done > $A/out/v59e_e_post.done
