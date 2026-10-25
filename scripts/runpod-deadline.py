#!/usr/bin/env python3
"""Stop this pod at its approved deadline using RunPod's injected scoped key.

No account-management credential or external dependency is needed. --check only
reads this pod; the normal invocation waits until MEMREPLAY_STOP_AT, then stops.
"""
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.request


def main():
    env = dict(os.environ)
    # SSH sessions need not inherit the container's injected environment.
    for item in Path('/proc/1/environ').read_bytes().split(b'\0'):
        if b'=' in item:
            key, value = item.split(b'=', 1)
            if key in (b'RUNPOD_API_KEY', b'RUNPOD_POD_ID', b'MEMREPLAY_STOP_AT'):
                env[key.decode()] = value.decode()
    pod_id = env['RUNPOD_POD_ID']
    if not re.fullmatch(r'[a-z0-9]+', pod_id):
        raise ValueError('Invalid injected pod ID')
    deadline = int(env['MEMREPLAY_STOP_AT'])
    if deadline > time.time() + 3 * 3600 + 60:
        raise ValueError('Deadline exceeds the approved initial three-hour window')
    url = 'https://api.runpod.io/v2/pods/' + pod_id
    headers = {'Authorization': 'Bearer ' + env['RUNPOD_API_KEY'], 'Content-Type': 'application/json'}

    def api(stop=False):
        req = urllib.request.Request(url + ('/action' if stop else ''),
            data=b'{"action":"stop"}' if stop else None,
            headers=headers, method='POST' if stop else 'GET')
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)

    while True:
        try:
            current = api()
            break
        except Exception as error:
            if '--check' in sys.argv:
                raise
            print('Initial API read retry: ' + type(error).__name__, flush=True)
            time.sleep(5)
    print(f"Deadline guard: pod={pod_id}, status={current['status']}, stopAt={deadline}", flush=True)
    if '--check' in sys.argv:
        if current['status'] == 'RUNNING' and 'stop' not in current.get('actions', []):
            raise RuntimeError('Pod does not currently allow stopping')
        return
    while time.time() < deadline:
        time.sleep(max(0, min(30, deadline - time.time())))
    while True:
        try:
            current = api()
            if current['status'] in ('EXITED', 'TERMINATED'):
                print('Pod stopped; network volume retained.', flush=True)
                return
            result = api(stop=True)
            print('Stop requested; status=' + result['status'], flush=True)
        except urllib.error.HTTPError as error:
            print(f'Stop retry: HTTP {error.code}', flush=True)
        except Exception as error:
            print('Stop retry: ' + type(error).__name__, flush=True)
        time.sleep(5)


if __name__ == '__main__':
    main()
