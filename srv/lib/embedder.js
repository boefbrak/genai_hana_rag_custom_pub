const { AzureOpenAiEmbeddingClient } = require('@sap-ai-sdk/foundation-models');

let embeddingClient = null;

function getEmbeddingClient() {
  if (!embeddingClient) {
    embeddingClient = new AzureOpenAiEmbeddingClient('text-embedding-3-large');
  }
  return embeddingClient;
}

async function embedTexts(texts, batchSize = 20) {
  const client = getEmbeddingClient();
  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (text) => {
        const response = await client.run({ input: text });
        return response.getEmbedding();
      })
    );
    allEmbeddings.push(...batchResults);
  }

  return allEmbeddings;
}

module.exports = { embedTexts };
