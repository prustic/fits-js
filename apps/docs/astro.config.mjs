import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";

export default defineConfig({
  site: "https://prustic.github.io",
  base: "/fits-js",
  integrations: [
    starlight({
      title: "fits-js",
      description: "A TypeScript FITS parser. Lazy random-access reads in Node and the browser.",
      lastUpdated: true,
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/prustic/fits-js",
        },
        {
          icon: "npm",
          label: "npm",
          href: "https://www.npmjs.com/package/@fits-js/core",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/prustic/fits-js/edit/main/apps/docs/",
      },
      plugins: [
        starlightTypeDoc({
          entryPoints: [
            "../../packages/fits-core/src/index.ts",
            "../../packages/fits-core/src/node.ts",
          ],
          tsconfig: "../../packages/fits-core/tsconfig.json",
          output: "api",
          sidebar: {
            label: "API reference",
            collapsed: false,
          },
          typeDoc: {
            entryPointStrategy: "resolve",
            excludePrivate: true,
            excludeInternal: true,
            excludeExternals: true,
            readme: "none",
            githubPages: false,
            hideGenerator: true,
            useCodeBlocks: true,
            expandObjects: true,
            parametersFormat: "table",
            entryFileName: "index",
            name: "API reference",
          },
        }),
      ],
      sidebar: [
        { label: "Quickstart", slug: "quickstart" },
        typeDocSidebarGroup,
        {
          label: "Project",
          items: [
            { label: "Roadmap", slug: "roadmap" },
            { label: "Contributing", slug: "contributing" },
            { label: "Changelog", slug: "changelog" },
          ],
        },
      ],
    }),
  ],
});
