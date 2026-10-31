# Hosted site template

The live memos site serves the built viewer and this upload API from one Cloudflare Worker, built from a separate
Sites (Vinext starter) checkout. `worker.ts` is that checkout's `worker/index.ts`: API routes go to
`handleHostedRequest`, the viewer and library pages are served as HTML, and everything else comes from static assets.
It only builds inside that checkout, so this repository does not type-check it.

To update the hosted site:

1. Copy `worker.ts` to `<checkout>/worker/index.ts` and this package's `src/` folder to `<checkout>/server/upload/src/`.
2. Build the viewer into the checkout: `node scripts/deploy/build-hosted-web.mjs <checkout>/public` (from the repository
   root; it bakes in the hosted database settings and leaves out local scenes).
3. In the checkout, keep the starter's `sites()` build integration, an R2 binding named `BUCKET`, and the `ASSETS`
   binding with `run_worker_first: true` and `html_handling: "none"`.
4. Set the runtime settings in the Sites dashboard, never in Git: `STDB_HTTP_URL`, `STDB_DATABASE`, `PUBLIC_ORIGIN`,
   `UPLOAD_ALLOWED_ORIGINS`, a stable `UPLOAD_SIGNING_SECRET` and, once a GPU worker runs, `PIPELINE_IDENTITY`.
5. Save and deploy with the Sites source and build workflow; rebuilding alone does not update the live site.
