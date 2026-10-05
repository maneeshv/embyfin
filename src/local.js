import {DurableObject} from 'cloudflare:workers';
import {handle} from '#src/worker.js';
import {SubtitleSession} from '#src/subtitle-auth.js';
import {ProviderSettings} from '#src/providers.js';

// Local subtitle sessions need durable storage without starting a processor container.
export class LocalMediaController extends DurableObject {
  constructor(ctx,env) {super(ctx,env);this.subtitles=new SubtitleSession(env,ctx.storage);this.providers=new ProviderSettings(env,ctx.storage,this.subtitles);}
  providerConfiguration() {return this.providers.configuration();}
  updateProvider(data) {return this.providers.update(data);}
  async subtitleSession(rejectedToken='',credentials) {return this.subtitles.get(rejectedToken,credentials ?? (await this.providers.configuration()).credentials);}
}

// This entrypoint is absent from the production module graph. No production header/query auth bypass.
export default {
  fetch(request,env,ctx) {
    const host=new URL(request.url).hostname;
    if (!['localhost','127.0.0.1','[::1]'].includes(host)) return new Response('Local development only',{status:403});
    return handle(request,env,ctx,()=>({email:env.OWNER_EMAIL,sub:'local-owner'}));
  },
};
