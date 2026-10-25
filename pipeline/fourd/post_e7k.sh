A=/workspace/4dgs/A
export FOURD_DYN_FLAG=1
bash $A/post.sh $A/runs/v59d/e $A/configs/v59d.py $A/data/v59d /workspace/work/v59 $A/out/v59_e 0 --iteration 7000 --do eval,export > $A/out/v59_e.log 2>&1
source /workspace/memory-replay/pipeline/runpod/env.sh; use world; source /workspace/envs/4dgs/bin/activate; export CUDA_VISIBLE_DEVICES=0
cd /tmp
for bg in 0 1; do python $A/static_eval.py x $A/data/v59d /workspace/work/v59 $A/out/v59_e/export_eval_bg$bg.json --frames $A/out/v59_e/frames --bg $bg > /dev/null 2>&1; done
cd $A/4DGaussians
python $A/motion.py -m $A/runs/v59d/e --configs $A/configs/v59d.py --data $A/data/v59d --work /workspace/work/v59 --iteration 7000 --out $A/out/v59_e/motion.json > $A/out/v59_e_motion.log 2>&1
python $A/compare.py -m $A/runs/v59d/e --configs $A/configs/v59d.py --work /workspace/work/v59 --shots $A/shots/v59 --iteration 7000 --out $A/out/v59_e/compare_e.jpg --name "run e" --bg 0 > $A/out/v59_e_compare.log 2>&1
echo done > $A/out/v59_e_post.done
