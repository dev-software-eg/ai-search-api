import { MongoClient } from "mongodb";

const DB_NAME = "ai-search";
const TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

let clientPromise;
let indexesEnsured;

function getClientPromise() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI environment variable is not set");
  }
  if (!clientPromise) {
    clientPromise = new MongoClient(process.env.MONGODB_URI).connect();
  }
  return clientPromise;
}

async function getChatLogsCollection() {
  const client = await getClientPromise();
  const collection = client.db(DB_NAME).collection("chatLogs");

  if (!indexesEnsured) {
    indexesEnsured = Promise.all([
      // Auto-expire a conversation 90 days after its last message.
      collection.createIndex(
        { timestamp: 1 },
        { expireAfterSeconds: TTL_SECONDS },
      ),
      // Sparse: docs without a conversationId (e.g. old data, or a caller
      // that didn't send one) are excluded, so they don't collide on it.
      collection.createIndex(
        { conversationId: 1 },
        { unique: true, sparse: true },
      ),
    ]);
  }
  await indexesEnsured;

  return collection;
}

// Never lets a logging failure break the caller's response — a Mongo outage
// should degrade to "no log written", not a 500 on the chat endpoint.
//
// Upserts on conversationId so a whole session collapses into a single
// document (each turn overwrites it with the latest full transcript)
// instead of one document per turn. Falls back to a plain insert if no
// conversationId was sent.
export async function logChat({ conversationId, ...rest }) {
  try {
    const collection = await getChatLogsCollection();
    if (conversationId) {
      await collection.updateOne(
        { conversationId },
        { $set: { conversationId, ...rest } },
        { upsert: true },
      );
    } else {
      // Omit the key entirely (rather than storing conversationId: null)
      // so the sparse unique index doesn't treat multiple such docs as
      // colliding on a shared null value.
      await collection.insertOne(rest);
    }
  } catch (err) {
    console.error("Failed to log chat:", err);
  }
}
