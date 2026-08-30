"use client";

import { initializePaddle } from "@paddle/paddle-js";

let paddlePromise = null;

/** Client overlay env. Must match server PADDLE_ENV. Defaults to sandbox. */
function paddleEnvironment() {
  const raw = String(process.env.NEXT_PUBLIC_PADDLE_ENV || "sandbox").toLowerCase();
  return raw === "production" || raw === "live" ? "production" : "sandbox";
}

export async function loadPaddle() {
  if (paddlePromise) return paddlePromise;
  const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
  if (!token) {
    throw new Error("Paddle checkout is not configured.");
  }
  paddlePromise = initializePaddle({
    environment: paddleEnvironment(),
    token,
  }).then((paddle) => {
    if (!paddle) throw new Error("Paddle checkout failed to load.");
    return paddle;
  });
  return paddlePromise;
}

/**
 * Open Paddle.js overlay for a server-created transaction.
 * Payment confirmation is webhook-driven — this does not mark the user Pro.
 */
export async function openPaddleOverlay({ transactionId, customerEmail } = {}) {
  if (!transactionId) {
    throw new Error("Checkout did not return a transaction.");
  }
  const paddle = await loadPaddle();
  const settings = {
    displayMode: "overlay",
    successUrl: `${window.location.origin}/billing?checkout=success`,
  };
  const payload = { transactionId, settings };
  if (customerEmail) {
    payload.customer = { email: customerEmail };
  }
  paddle.Checkout.open(payload);
}
