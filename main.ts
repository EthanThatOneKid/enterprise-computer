import { chunk } from "@std/collections/chunk";
import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: Deno.env.get("GEMINI_API_KEY")! });

const prompt =
  "Given a transcript of Star Trek: The Next Generation, extract the dialogues toward the Computer and the responses spoken by the Computer:\n" +
  "\n" +
  "Cite ONLY the following text:";

if (import.meta.main) {
  const startAt = 0;

  // https://github.com/varenc/star_trek_transcript_search/tree/main/scripts/NextGen
  const tngDir = (await readGitHubDirectory(
    "varenc",
    "star_trek_transcript_search",
    "scripts/NextGen",
  )).slice(startAt);

  for (const files of chunk(tngDir, 1)) {
    const output = await Promise.all(
      files.map(async ({ download_url, name }) => {
        const content = await fetch(download_url).then((response) =>
          response.text()
        );

        const aiResult = await ai.models.generateContent({
          model: "gemini-2.5-flash-preview-04-17", // https://ai.google.dev/gemini-api/docs/models
          contents: `${prompt}\n${content}`,
          config: { // https://ai.google.dev/gemini-api/docs/structured-output?lang=node#supply-schema-in-config
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ["query", "response"],
                properties: {
                  user: {
                    type: Type.STRING,
                    description: "Creator of the query",
                  },
                  query: { type: Type.STRING, description: "User query" },
                  response: {
                    type: Type.STRING,
                    description: "Computer response",
                  },
                },
              },
            },
          },
        });

        return [name, aiResult.text];
      }),
    );

    for (const [name, text] of output) {
      if (!text || text === "[]") {
        continue;
      }

      await Deno.writeTextFile(
        `./output/${name!.replace(/\.txt$/, "")}.json`,
        text,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
}

async function readGitHubDirectory(
  owner: string,
  repo: string,
  path: string,
): Promise<Array<{ download_url: string; name: string }>> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  return await fetch(url).then((response) => response.json());
}
