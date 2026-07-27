import {
  handleWorldconsSearchRequest,
  type SearchWorkerEnv,
} from "./handler";

type WorkerEnv = Cloudflare.Env & Pick<
  SearchWorkerEnv,
  "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY"
>;

export default {
  fetch(request, env): Promise<Response> {
    return handleWorldconsSearchRequest(request, env);
  },
} satisfies ExportedHandler<WorkerEnv>;
