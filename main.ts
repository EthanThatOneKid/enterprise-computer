import { chunk } from "@std/collections/chunk";
import { Spinner } from "@std/cli/unstable-spinner";
import { retry } from "@std/async/retry";
import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({
  // https://aistudio.google.com/app/apikey
  apiKey: Deno.env.get("GEMINI_API_KEY")!,
});

const prompt =
  `Given a transcript of a single episode of Star Trek: The Next Generation, extract the dialogue directed toward the Computer and the responses spoken by the Computer. The given transcript is a single episode of the series, formatted such that each line follows the structure "[Speaker's name]: [Speaker's text]".\n` +
  `Only include dialogues where the Computer is a speaker. The property \`userName\` should contain the name of the character speaking to the Computer (e.g., "Data", "Picard", "Riker"). The property \`computerReply\` should contain ONLY the dialogue text spoken by the Computer (e.g., "All circuits functional." or "Confirmed."), WITHOUT any speaker prefix like "COMPUTER:" or "[Speaker's name]:". The property \`userQuery\` should include ONLY the dialogue text addressing the Computer, also WITHOUT any speaker prefix.\n` +
  `Ensure that only dialogues directly involving the Computer are included, excluding any dialogues without the Computer speaking.\n` +
  `\n` +
  `Cite ONLY the following text:\n`;

if (import.meta.main) {
  const startAt = 0;
  const batchSize = 5; // Process 5 episodes at a time for better efficiency

  console.error("🚀 Starting Star Trek: TNG Computer Dialogue Extraction");
  console.error("📡 Fetching episode list from GitHub...");
  console.error(
    "🔗 Repository: varenc/star_trek_transcript_search/scripts/NextGen",
  );

  // https://github.com/varenc/star_trek_transcript_search/tree/main/scripts/NextGen
  const tngDir = (
    await readGitHubDirectory(
      "varenc",
      "star_trek_transcript_search",
      "scripts/NextGen",
    )
  ).slice(startAt);

  console.error(`📺 Found ${tngDir.length} episodes to process`);
  console.error(`⚡ Processing in batches of ${batchSize} episodes`);
  console.error(`🎯 Starting from episode index: ${startAt}`);
  console.error(
    `⏱️  Estimated total time: ~${
      Math.ceil((tngDir.length / batchSize) * 5 / 60)
    } minutes\n`,
  );

  let processedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const files of chunk(tngDir, batchSize)) {
    const batchNumber = Math.floor(processedCount / batchSize) + 1;
    const totalBatches = Math.ceil(tngDir.length / batchSize);

    console.error(
      `\n📦 Batch ${batchNumber}/${totalBatches} - Processing ${files.length} episode(s)`,
    );

    const spinner = new Spinner({
      message: "Processing episodes...",
      color: "cyan",
      output: Deno.stderr,
    });
    spinner.start();

    try {
      const output = await Promise.all(
        files.map(async ({ download_url, name }) => {
          try {
            spinner.message = `Starting episode: ${name}`;

            // Step 1: Download transcript
            spinner.message = `📥 Downloading transcript: ${name}`;
            const content = await fetch(download_url).then((response) => {
              if (!response.ok) {
                throw new Error(
                  `HTTP ${response.status}: ${response.statusText}`,
                );
              }
              return response.text();
            });
            spinner.message =
              `📄 Transcript downloaded: ${name} (${content.length} chars)`;

            // Step 2: Check for Computer dialogue
            spinner.message = `🔍 Scanning ${name} for Computer dialogue...`;
            if (!content.includes("COMPUTER:")) {
              spinner.message =
                `⏭️  Skipping ${name} (no Computer dialogue found)`;
              skippedCount++;
              return [name, "[]", "skipped"];
            }
            spinner.message = `✅ Computer dialogue detected in ${name}`;

            // Step 3: AI Analysis
            spinner.message = `🤖 Analyzing ${name} with AI...`;

            // Create a retryable function for AI processing
            const processWithAI = async () => {
              const aiResult = await ai.models.generateContent({
                // https://ai.google.dev/gemini-api/docs/models
                model: "models/gemini-2.5-flash", // "models/gemini-2.5-flash-lite",
                contents: `${prompt}\n${content}`,
                config: {
                  // https://ai.google.dev/gemini-api/docs/structured-output?lang=node#supply-schema-in-config
                  temperature: 0,
                  responseMimeType: "application/json",
                  responseSchema: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      required: [
                        "situationalContext",
                        "userQuery",
                        "computerReply",
                        "userName",
                      ],
                      properties: {
                        situationalContext: {
                          type: Type.STRING,
                          description:
                            "Sentence describing the situational context",
                        },
                        userName: {
                          type: Type.STRING,
                          description:
                            "Name of the character speaking to the Computer",
                        },
                        userQuery: {
                          type: Type.STRING,
                          description: "Query directed to the Computer",
                        },
                        computerReply: {
                          type: Type.STRING,
                          description: "Response spoken by the Computer",
                        },
                      },
                    },
                  },
                },
              });

              return aiResult;
            };

            // Retry AI processing up to 3 times before giving up
            spinner.message = `🚀 AI processing ${name} (attempt 1/3)...`;
            const aiResult = await retry(processWithAI, { maxAttempts: 3 });

            spinner.message = `✅ AI analysis completed for ${name}`;
            spinner.message = `📊 Extracted data from ${name}: ${
              aiResult.text?.length || 0
            } chars`;
            return [name, aiResult.text, "success"];
          } catch (error) {
            const errorMessage = error instanceof Error
              ? error.message
              : String(error);
            console.error(
              `❌ Error processing ${name} after retries: ${errorMessage}`,
            );
            errorCount++;
            return [name, "[]", "error"];
          }
        }),
      );

      // Write all files in parallel
      const successfulOutputs = output.filter(([_, text, status]) =>
        status === "success" && text && text !== "[]"
      );

      if (successfulOutputs.length > 0) {
        spinner.message =
          `💾 Writing ${successfulOutputs.length} output file(s)...`;

        const writePromises = successfulOutputs.map(async ([name, text]) => {
          if (name && text) {
            const outputPath = `./output/${name.replace(/\.txt$/, "")}.json`;
            spinner.message = `💾 Writing ${name} to ${outputPath}...`;
            await Deno.writeTextFile(outputPath, text);
            spinner.message = `✅ ${name} saved successfully`;
          }
        });

        await Promise.all(writePromises);
        spinner.message =
          `💾 All ${successfulOutputs.length} files written successfully`;
      } else {
        spinner.message = `⚠️  No successful outputs to write for this batch`;
      }

      processedCount += files.length;

      spinner.stop();
      console.error(`✅ Batch ${batchNumber}/${totalBatches} completed`);
      console.error(
        `📊 Progress: ${processedCount}/${tngDir.length} episodes processed`,
      );

      // Calculate remaining episodes and estimated time
      const remainingEpisodes = tngDir.length - processedCount;
      const remainingBatches = Math.ceil(remainingEpisodes / batchSize);
      const estimatedMinutes = Math.ceil((remainingBatches * 5) / 60);

      if (remainingEpisodes > 0) {
        console.error(
          `⏱️  Estimated time remaining: ~${estimatedMinutes} minutes`,
        );
        console.error(`📦 ${remainingBatches} batch(es) remaining`);
      }

      // Only wait between batches if there are more to process
      if (processedCount < tngDir.length) {
        console.error("⏳ Waiting 5 seconds before next batch...");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    } catch (error) {
      spinner.stop();
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      console.error(`❌ Batch ${batchNumber} failed: ${errorMessage}`);
      errorCount += files.length;
    }
  }

  // Final summary
  console.error("\n" + "=".repeat(60));
  console.error("🎉 PROCESSING COMPLETE!");
  console.error("=".repeat(60));
  console.error(`📺 Total episodes: ${tngDir.length}`);
  console.error(`✅ Successfully processed: ${processedCount - errorCount}`);
  console.error(`⏭️  Skipped (no Computer dialogue): ${skippedCount}`);
  console.error(`❌ Errors: ${errorCount}`);
  console.error("=".repeat(60));
}

async function readGitHubDirectory(
  owner: string,
  repo: string,
  path: string,
): Promise<Array<{ download_url: string; name: string }>> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch GitHub directory: HTTP ${response.status}`,
    );
  }

  return await response.json();
}
