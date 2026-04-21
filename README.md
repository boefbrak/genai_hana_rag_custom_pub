## create and update following

### Database Layer (db/)
| File | Description |
|------|-------------|
| **schema.cds** | CDS data model defining four entities: `Documents` (uploaded files metadata), `DocumentChunks` (text chunks with Vector(3072) embeddings), `ChatSessions` (conversation sessions), `ChatMessages` (individual messages with sources) |


#### CDS data model defining four entities

`db/schema.cds`

```cds
namespace genai.rag;

using { cuid, managed } from '@sap/cds/common';

entity Documents : cuid, managed {
  fileName    : String(255)  @mandatory;
  fileType    : String(10)   @mandatory;
  fileSize    : Integer;
  status      : String(20)   default 'UPLOADED';
  chunkCount  : Integer      default 0;
  errorMsg    : String(1000);
  chunks      : Composition of many DocumentChunks on chunks.document = $self;
}

entity DocumentChunks : cuid {
  document    : Association to Documents @mandatory;
  content     : LargeString  @mandatory;
  chunkIndex  : Integer      @mandatory;
  tokenCount  : Integer;
  embedding   : Vector(3072);
}

entity ChatSessions : cuid, managed {
  title       : String(200);
  document    : Association to Documents;  // Link session to document
  messages    : Composition of many ChatMessages on messages.session = $self;
}

entity ChatMessages : cuid {
  session     : Association to ChatSessions @mandatory;
  role        : String(20)   @mandatory;
  content     : LargeString  @mandatory;
  timestamp   : Timestamp    @cds.on.insert: $now;
  sources     : LargeString;
}
```

### Service Layer (`srv/`)

| File | Description |
|------|-------------|
| **document-service.cds** | OData service definition exposing Documents entity and actions: `upload`, `getStatus`, `deleteDocument`, `getDeletePreview` |
| `document-service.js` | Handler implementing document CRUD, cascade delete (chunks → sessions → messages), and delete preview |
| `chat-service.cds` | OData service definition exposing ChatSessions/ChatMessages and actions: `createSession`, `updateSession`, `sendMessage`, `getSessionMessages`, `getDocumentSessions` |
| `chat-service.js` | Handler implementing document-scoped chat with RAG pipeline integration |
| `server.js` | Custom Express middleware for multipart file upload (multer) and CORS headers |


#### OData service definition exposing Documents entity and actions

`document-service.cds`

```cds
using { genai.rag as db } from '../db/schema';

service DocumentService @(path: '/api/documents') {

  entity Documents as projection on db.Documents excluding { chunks };

  action deleteDocument(documentId: UUID) returns Boolean;

  function getStatus(documentId: UUID) returns {
    status: String;
    chunkCount: Integer;
    errorMsg: String;
  };

  function getDeletePreview(documentId: UUID) returns {
    sessionCount: Integer;
    messageCount: Integer;
    chunkCount: Integer;
  };
}
```

#### OData service definition exposing ChatSessions/ChatMessages and actions

`chat-service.cds`

```cds
using { genai.rag as db } from '../db/schema';

service ChatService @(path: '/api/chat') {

  entity ChatSessions as projection on db.ChatSessions excluding { messages };
  entity ChatMessages as projection on db.ChatMessages;

  action sendMessage(sessionId: UUID, message: String) returns {
    reply: String;
    messageId: UUID;
    sources: array of {
      chunkId: UUID;
      documentName: String;
      content: String;
      similarity: Double;
    };
  };

  action createSession(documentId: UUID, title: String) returns ChatSessions;
  action updateSession(sessionId: UUID, documentId: UUID, title: String) returns ChatSessions;

  function getSessionMessages(sessionId: UUID) returns array of ChatMessages;
  function getDocumentSessions(documentId: UUID) returns array of ChatSessions;
}
```


### Library Files (`srv/lib/`)

| File | Description |
|------|-------------|
| `file-parser.js` | Extracts text from uploaded files: `pdf-parse` for PDFs, direct buffer conversion for TXT, `csv-parse` for CSV (converts to "Column: Value" format) |
| `chunker.js` | Splits text into chunks of ~1000 tokens with ~200 token overlap, breaking at sentence boundaries for better context preservation |
| `embedder.js` | Wraps SAP AI SDK's `AzureOpenAiEmbeddingClient` for `text-embedding-3-large` model, processes in batches of 20 texts |
| `vector-search.js` | Executes HANA SQL with `COSINE_SIMILARITY()` function to find top-K similar chunks to a query embedding |
| **rag-engine.js** | Wraps SAP AI SDK's `AzureOpenAiChatClient` for `gpt-4o`, constructs RAG prompts with document context and chat history |
| `upload-processor.js` | Orchestrates async document processing: parse → chunk → embed → store with vector, updates document status |


####  Wrap SAP AI SDK's `AzureOpenAiChatClient` for `gpt-4o`, constructs RAG prompts with document context and chat history

`srv/lib/rag-engine.js`

```js
const { AzureOpenAiChatClient } = require('@sap-ai-sdk/foundation-models');

let chatClient = null;

function getChatClient() {
  if (!chatClient) {
    chatClient = new AzureOpenAiChatClient('gpt-4o');
  }
  return chatClient;
}

const SYSTEM_PROMPT = `You are a helpful AI assistant that answers questions based on the provided document context.

Rules:
1. Answer ONLY based on the provided context. If the context doesn't contain enough information, say so clearly.
2. Cite which document(s) your answer is based on when possible.
3. Be concise but thorough.
4. If the user's question is a greeting or general conversation, respond naturally.
5. Maintain a professional and helpful tone.`;

async function generateRAGResponse({ query, chunks, history }) {
  const client = getChatClient();

  const contextParts = chunks.map((chunk, idx) => {
    const similarity = (chunk.similarity * 100).toFixed(1);
    // Handle NCLOB content - may be Buffer or string
    let contentStr = chunk.content;
    if (Buffer.isBuffer(contentStr)) {
      contentStr = contentStr.toString('utf8');
    } else if (typeof contentStr !== 'string') {
      contentStr = String(contentStr || '');
    }
    return `[Source ${idx + 1}: "${chunk.documentName}", relevance: ${similarity}%]\n${contentStr}`;
  });

  const contextBlock = contextParts.length > 0
    ? `\n\n--- DOCUMENT CONTEXT ---\n${contextParts.join('\n\n---\n\n')}\n--- END CONTEXT ---\n\n`
    : '\n\n[No relevant documents found in the knowledge base.]\n\n';

  const messages = [];

  messages.push({
    role: 'system',
    content: SYSTEM_PROMPT + contextBlock
  });

  // Add chat history (excluding the current user message which is last)
  const historyWithoutCurrent = history.slice(0, -1);
  for (const msg of historyWithoutCurrent) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      // Handle NCLOB content - may be Buffer or string
      let msgContent = msg.content;
      if (Buffer.isBuffer(msgContent)) {
        msgContent = msgContent.toString('utf8');
      } else if (typeof msgContent !== 'string') {
        msgContent = String(msgContent || '');
      }
      messages.push({ role: msg.role, content: msgContent });
    }
  }

  messages.push({ role: 'user', content: query });

  const response = await client.run({
    messages,
    max_tokens: 2000,
    temperature: 0.3
  });

  return response.getContent();
}

module.exports = { generateRAGResponse };

```