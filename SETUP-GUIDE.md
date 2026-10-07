# Setup Guide: Code Changes Required

This guide walks you through the code changes needed to bring the project to life. Each section tells you exactly which file to open, what it does, and what code to paste in.

---

## 1. Database Schema

**File to update:** `db/schema.cds`

**What this change does:**
Defines the four core database tables used by the application. `Documents` stores metadata about uploaded files (name, type, size, processing status). `DocumentChunks` holds the individual text segments split from each document, including a 3072-dimension vector embedding used for semantic similarity search. `ChatSessions` groups conversations and links them to a specific document. `ChatMessages` stores the full message history (both user and AI replies) along with the source chunks that informed each answer.

Find `db/schema.cds` and replace its contents with the following code:

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

---

## 2. Document Service Definition

**File to update:** `srv/document-service.cds`

**What this change does:**
Exposes the `Documents` entity as an OData service at the `/api/documents` path. It hides the raw `chunks` association from API consumers (they only interact with document-level metadata). It also declares three operations: `deleteDocument` to remove a document and all its related data; `getStatus` to poll the processing state of an uploaded document; and `getDeletePreview` to show a summary of what will be deleted (sessions, messages, chunks) before a destructive action is confirmed.

Find `srv/document-service.cds` and replace its contents with the following code:

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

---

## 3. Chat Service Definition

**File to update:** `srv/chat-service.cds`

**What this change does:**
Exposes the chat functionality as an OData service at the `/api/chat` path. It surfaces `ChatSessions` and `ChatMessages` entities for reading. The `sendMessage` action is the core of the RAG pipeline — it accepts a session ID and a user message, then returns the AI-generated reply alongside the source document chunks that were used to produce it (including similarity scores). The remaining actions and functions handle session lifecycle: creating a new chat tied to a document, updating session metadata, and fetching messages or sessions by ID.

Find `srv/chat-service.cds` and replace its contents with the following code:

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

---

## 4. RAG Engine

**File to update:** `srv/lib/rag-engine.js`

**What this change does:**
Implements the AI response logic using the SAP AI SDK's `AzureOpenAiChatClient` pointed at the `gpt-4o` model. The client is initialised once and reused (singleton pattern). The `generateRAGResponse` function assembles a structured prompt: it injects a system instruction that constrains the model to answer only from provided document context, appends the relevant retrieved chunks (with source attribution and similarity percentages), replays prior chat history so the model is aware of the conversation, and finally adds the user's current question. Buffer-to-string conversion handles HANA NCLOB columns that may arrive as Node.js `Buffer` objects rather than plain strings. The model is called with a moderate temperature (0.3) for factual, consistent answers.

Find `srv/lib/rag-engine.js` and replace its contents with the following code:

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

---

## Summary of Changes

| File | Layer | Purpose |
|------|-------|---------|
| `db/schema.cds` | Database | Creates the four entities: Documents, DocumentChunks, ChatSessions, ChatMessages |
| `srv/document-service.cds` | Service API | Exposes document upload/management endpoints via OData |
| `srv/chat-service.cds` | Service API | Exposes chat and RAG pipeline endpoints via OData |
| `srv/lib/rag-engine.js` | Business Logic | Calls GPT-4o via SAP AI SDK to generate context-aware answers |

After applying all four changes, the backend data model, OData APIs, and AI response engine will be fully wired up.
