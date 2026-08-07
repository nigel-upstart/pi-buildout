declare module "eslint-plugin-security" {
  import type { Linter } from "eslint";

  const plugin: Linter.Plugin;
  export default plugin;
}
