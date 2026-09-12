import {handle} from './worker.js';
// This entrypoint is absent from the production module graph. No production header/query auth bypass.
export default {
  fetch(request,env,ctx) {
    const host=new URL(request.url).hostname;
    if (!['localhost','127.0.0.1','[::1]'].includes(host)) return new Response('Local development only',{status:403});
    return handle(request,env,ctx,()=>({email:env.OWNER_EMAIL,sub:'local-owner'}));
  },
};
