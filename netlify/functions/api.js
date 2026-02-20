"use strict";

const serverless = require("serverless-http");
const { server } = require("../../server");

const baseHandler = serverless(server);

function normalizePath(event) {
  const original = String(event?.path || "");
  const fnPrefix = "/.netlify/functions/api";
  if (!original.startsWith(fnPrefix)) return original;

  let rest = original.slice(fnPrefix.length);
  if (!rest.startsWith("/")) rest = `/${rest}`;
  if (!rest.startsWith("/api/")) rest = `/api${rest}`;
  return rest;
}

async function handler(event, context) {
  const path = normalizePath(event);
  const normalizedEvent = path ? { ...event, path } : event;
  return baseHandler(normalizedEvent, context);
}

module.exports = { handler };
