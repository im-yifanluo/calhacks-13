import { writeFile } from "node:fs/promises";
const id = process.argv[2];
if (!id || !/^[0-9]+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(id)) {
  console.error(
    "Usage: npm run auth:configure -- YOUR_WEB_CLIENT_ID.apps.googleusercontent.com",
  );
  process.exit(1);
}
await writeFile(
  new URL("../server/spacetime/src/google-config.ts", import.meta.url),
  `// Public OAuth web client ID. Republish the database and rebuild the web app after changing it.\nexport const GOOGLE_CLIENT_ID: string = ${JSON.stringify(id)};\n`,
);
console.log(
  "Google web client ID configured. Now republish SpacetimeDB and rebuild the web app. No client secret is needed.",
);
