/** Standalone deployment of the same API used by the memos website. */
import { handleHostedRequest } from './worker.mjs';

export default {
  async fetch(request, env) {
    return await handleHostedRequest(request, env) ?? Response.json({ error: 'Not found' }, { status: 404 });
  },
};
