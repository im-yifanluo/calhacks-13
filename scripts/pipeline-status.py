"""P1/P2 handoff: authenticated HTTP reducer call; token stays on the GPU host."""
import argparse, json, os, urllib.request
p=argparse.ArgumentParser()
p.add_argument('memory_id',type=int)
p.add_argument('status',choices=['processing','ready','failed'])
p.add_argument('--progress',type=float,required=True)
p.add_argument('--manifest-url',default='')
p.add_argument('--error',default='')
a=p.parse_args()
base=os.environ['STDB_HTTP_URL'].rstrip('/')
request=urllib.request.Request(f"{base}/v1/database/{os.environ['STDB_DATABASE']}/call/set_memory_status",
  data=json.dumps([a.memory_id,a.status,a.progress,a.manifest_url,a.error]).encode(),
  headers={'Authorization':'Bearer '+os.environ['PIPELINE_TOKEN'],'Content-Type':'application/json'},method='POST')
with urllib.request.urlopen(request,timeout=30) as response:
    print('Status accepted:',response.status)
