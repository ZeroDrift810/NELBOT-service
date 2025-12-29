import app from "./server"
import { registerContractNotifier, initializeContractCaches } from "./discord/contract_notifier"
import { registerDraftNotifier, initializeDraftCaches } from "./discord/draft_notifier"

const port = process.env.PORT || 3000

// Register event notifiers
registerContractNotifier()
registerDraftNotifier()

// Initialize caches asynchronously
initializeContractCaches().catch(e => {
  console.error("[CONTRACT] Failed to initialize caches on startup:", e)
})

initializeDraftCaches().catch(e => {
  console.error("[DRAFT] Failed to initialize caches on startup:", e)
})

app.listen(port, () => {
  console.log(`server started on ${port}`);
});
