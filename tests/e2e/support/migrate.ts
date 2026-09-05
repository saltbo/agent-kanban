import { join } from "node:path";
import { Miniflare } from "miniflare";
import { applyMigrations } from "../../helpers/db";

const stateDir = process.env.AK_E2E_STATE_DIR;
if (!stateDir) throw new Error("AK_E2E_STATE_DIR is required for isolated E2E migrations");
const mf = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('ok'); } }",
  d1Databases: { DB: "13cdf435-a99c-4744-9eca-9ed22b232581" },
  d1Persist: join(stateDir, "v3/d1"),
});
try {
  await applyMigrations(await mf.getD1Database("DB"));
} finally {
  await mf.dispose();
}
