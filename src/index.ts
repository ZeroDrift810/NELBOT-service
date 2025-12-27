import app from "./server"
import { registerContractNotifier, initializeContractCaches } from "./discord/contract_notifier"

const port = process.env.PORT || 3000

// Register event notifiers
registerContractNotifier()

// Initialize caches asynchronously
initializeContractCaches().catch(e => {
  console.error("[CONTRACT] Failed to initialize caches on startup:", e)
})

app.listen(port, () => {
  console.log(`server started on ${port}`);
});
