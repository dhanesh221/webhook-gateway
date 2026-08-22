import express from "express";

// Separate from index.ts so tests can import the app without starting a real server.
export const app = express();

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});
