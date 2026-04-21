## create and update following

### Database Layer (db/)
| File | Description |
|------|-------------|
| `schema.cds` | CDS data model defining four entities: `Documents` (uploaded files metadata), `DocumentChunks` (text chunks with Vector(3072) embeddings), `ChatSessions` (conversation sessions), `ChatMessages` (individual messages with sources) |


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
| **`document-service.cds`** | OData service definition exposing Documents entity and actions: `upload`, `getStatus`, `deleteDocument`, `getDeletePreview` |
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

