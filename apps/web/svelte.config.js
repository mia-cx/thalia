import adapter from "@sveltejs/adapter-static";
import { webBase } from "./src/lib/paths.js";

/** @type {import("@sveltejs/kit").Config} */
const config = {
  kit: {
    // Prerendered pages keep their own files; 200.html is the fallback for client-side routes.
    adapter: adapter({ fallback: "200.html" }),
    paths: { base: webBase },
  },
};

export default config;
