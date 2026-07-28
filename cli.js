// benchgen-openclaw CLI
//
// Registers `openclaw benchgen configure` and `openclaw benchgen status`.
// The wizard writes keys straight into openclaw.json (plugins.entries.benchgen),
// so users never hand-edit config. Mirrors the Opik plugin's setup UX.

const CONFIGURE_DESC = "Interactive setup for Benchgen streaming";
const STATUS_DESC = "Show current Benchgen configuration";

async function runConfigureLazy(deps) {
  const { runBenchgenConfigure } = await import("./configure.js");
  await runBenchgenConfigure(deps);
}

async function showStatusLazy(deps) {
  const { showBenchgenStatus } = await import("./configure.js");
  showBenchgenStatus(deps);
}

/**
 * @param {{ program: any, getConfig: () => any, mutateConfigFile: (opts: { mutate: (draft: any) => void, afterWrite: any }) => Promise<any> }} params
 */
export function registerBenchgenCli(params) {
  const { program, getConfig, mutateConfigFile } = params;
  const deps = { getConfig, mutateConfigFile };

  const root = program.command("benchgen").description("Benchgen streaming integration");

  root
    .command("configure")
    .description(CONFIGURE_DESC)
    .action(async () => {
      await runConfigureLazy(deps);
    });

  root
    .command("status")
    .description(STATUS_DESC)
    .action(async () => {
      await showStatusLazy(deps);
    });
}
