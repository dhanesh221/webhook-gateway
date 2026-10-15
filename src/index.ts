// Loads .env.local into process.env before anything reads it.
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { app } from "./app";
import { loadRoutingRules } from "./routing";

loadRoutingRules(); // throws on a malformed WG_ROUTING_RULES, before the port is bound

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`webhook-gateway listening on port ${PORT}`);
});
