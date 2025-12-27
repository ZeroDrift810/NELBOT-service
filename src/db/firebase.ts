import { initializeApp, AppOptions } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs"; // Keep this line, although not directly used in simplified logic

function setupFirebase() {
  let appOptions: AppOptions = {};

  // Check if emulator environment variables are set
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    console.log(`🔥 Firebase: Connecting to EMULATOR at ${process.env.FIRESTORE_EMULATOR_HOST}`);
    // For emulator, projectId is often optional or can be a dummy value
    appOptions = { projectId: process.env.GCLOUD_PROJECT || "nel-bot-project" }; // Use configured project ID or default
    initializeApp(appOptions);
  }
  // Check if the standard Google Cloud service account environment variable is set for live database
  else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log(`☁️ Firebase: Connecting to LIVE database using Service Account specified in GOOGLE_APPLICATION_CREDENTIALS.`);
    // Initialize without specific credential options.
    // The Admin SDK automatically uses GOOGLE_APPLICATION_CREDENTIALS when this is called empty.
    initializeApp();
  }
  // If neither emulator nor service account is configured, throw an error
  else {
    console.error("❌ Firebase initialization failed: Required environment variables not set.");
    throw new Error(
      "Firebase initialization failed: Neither FIRESTORE_EMULATOR_HOST (for emulator) nor GOOGLE_APPLICATION_CREDENTIALS (for live database) environment variables are set."
    );
  }

  // Get Firestore instance
  const db = getFirestore();

  // Note: Explicit emulator settings like db.settings({...}) are often not needed if projectId is correct during initializeApp.
  // We will leave them out for simplicity unless connection issues arise.

  console.log("✅ Firestore instance obtained.");
  return db;
}

// Initialize database connection when this module is loaded
const db = setupFirebase();

// Export the initialized Firestore instance
export default db;