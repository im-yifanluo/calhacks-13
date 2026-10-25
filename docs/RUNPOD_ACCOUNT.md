# Connect your RunPod account to memos

The iPhone app and website continue to use `https://memos.alightdell64.chatgpt.site` and the existing SpacetimeDB database, `jerry-memory-replay-phone-20261024`. RunPod hosts the reconstruction worker; users do not log in to RunPod from the phone or website.

## Account authorization

Install the current official [RunPod CLI](https://github.com/runpod/runpodctl) and authorize your account with RunPod's browser sign-in flow. On the current Mac, the tools are installed under ignored `data/runpod-tools/`:

```sh
data/runpod-tools/flash-env/bin/flash login --no-open
data/runpod-tools/bin/runpodctl user
data/runpod-tools/bin/runpodctl pod list --all
```

The browser approval creates a resource-management credential in `~/.runpod/config.toml` with mode `0600`. Flash 1.21 saves `[default].api_key`; runpodctl 3.0.1 reads the top-level `apikey`. On this Mac those two fields were synchronized after browser approval. Never print or commit that file. Flash is used only for this login flow, not to run or deploy the application.

The account connection is verified when `runpodctl user` succeeds. It does not prove a GPU worker exists. Check current capacity and prices before creating a pod or volume. A running pod incurs compute charges even when idle; a network volume bills until it is deleted.

## Connect this checkout to your pod

Register the dedicated public SSH key only after approving the account access change. The private key stays on the Mac. On the current checkout its path is `data/runpod-account/memos-worker-ed25519`; the public counterpart has the `.pub` suffix.

```sh
data/runpod-tools/bin/runpodctl ssh add-key --key-file data/runpod-account/memos-worker-ed25519.pub
data/runpod-tools/bin/runpodctl ssh list-keys
data/runpod-tools/bin/runpodctl ssh info YOUR_POD_ID
```

Use a CUDA 12.8-compatible GPU pod with SSH enabled and port `22/tcp`. The pipeline's models, environments and working files belong on a persistent network volume mounted at `/workspace`.

Copy `pipeline/runpod/ssh.env.example` to ignored `data/runpod-account/ssh.env`. Fill in the direct SSH host and port from the live `ssh info` response and the **absolute path** to your private key. The helpers refuse to run without this configuration; they no longer default to a teammate's machine, IP or key. Refresh the host/port after a pod restart.

```sh
bash pipeline/runpod/pod.sh 'nvidia-smi -L'
bash pipeline/runpod/sync.sh
```

The helpers remember host keys in `data/runpod-account/known_hosts` and reject changed keys. Source sync excludes local data, credentials and video/scene assets. `pull.sh CLIP_ID` retrieves a finished scene into the current checkout for local viewing.

## Worker identity and activation

The worker's SpacetimeDB credential is separate from the RunPod API credential. Reuse the existing ignored `data/runpod-worker.env` on this Mac. If setting up a new project with no worker identity, run `scripts/configure-runpod-worker.mjs` as described in [RUNPOD_INTEGRATION.md](RUNPOD_INTEGRATION.md).

Securely copy the worker environment to `/root/memos-worker.env` with mode `0600` and symlink `/workspace/memos-worker.env` to it. The current network volume reports mode `0666` even after `chmod 600`, so credentials must stay on the container filesystem. The startup script verifies the resolved file permissions before loading it. Recopy the credential if the container is replaced. Never transfer the RunPod account API key to the website, phone app or worker environment. The worker needs its dedicated SpacetimeDB token and the memos upload API, not the account-management credential.

Run `pipeline/runpod/on_start.sh` and `setup.sh base world vipe warmup` on the pod. Set `TORCH_CUDA_ARCH_LIST=9.0` for an H100-only build. After the GPU/model checks pass, configure the upload service's `PIPELINE_IDENTITY` with the worker's public identity, run `start-worker.sh --check`, and start one worker. Then run `npm run test:pipeline:live -- --clip /absolute/path/to/real-glasses-clip.mp4`.

Keep reconstruction disabled on the public API until the worker is ready. Upload storage and account libraries continue working independently. A successful local test with substituted GPU stages is not a successful live reconstruction.

## Initial runtime limit

This account's first worker was approved for at most three hours. `scripts/provision-runpod-worker.py` records an absolute deadline before creation, embeds `scripts/runpod-deadline.py` into the pod startup, and runs a second shutdown watchdog on the Mac. Keep that local process alive under `caffeinate` during the initial session. The pod guard uses its own injected scoped credential with REST v2; the image's bundled runpodctl 1.14 cannot authenticate to its legacy GraphQL API with that credential.

The guard issues **stop**, then reads the state back. It does not terminate the pod or delete the network volume. Verify `EXITED` with the current CLI after a run; persistent storage continues to bill. Extending the initial deadline or starting another paid run requires a new runtime decision. If the worker is stopped, disable the site's `PIPELINE_IDENTITY` so new recordings remain storage-only until it is restarted.
