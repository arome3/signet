import type { PaymentRequirements } from "@x402/core/types";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { randomHex } from "../core/canonical.js";
import type { Challenge } from "../core/challenge.js";
import { utcDay } from "../core/mandate.js";
import type { Order, Receipt } from "../core/protocol.js";

/**
 * Each order is single-use: quoted -> in_flight (claimed synchronously on the first pay attempt, before
 * any await) -> paid | rejected. An order found in_flight after a restart stays in_flight: whether it
 * settled is unknown, so it is never paid again.
 */
export type OrderState = "quoted" | "in_flight" | "paid" | "rejected";

export interface Pending {
  state: OrderState;
  order: Order;
  orderHash: string;
  session: string;
  challenge: Challenge;
  requirements: PaymentRequirements;
  buyerBadge: string;
  ageOver?: number;
  ageRequest?: unknown;
  paid?: Receipt;
}

interface StateFile {
  v: 1;
  orders: Record<string, Pending>;
  /** Hash of every payment payload presented -> when it was first seen. */
  seenPayments: Record<string, string>;
  /** `${buyerBadge}|${day}|${asset}` -> atomic units received. */
  received: Record<string, string>;
}

const KEEP_MS = 2 * 86400_000;

/**
 * The merchant's replay-relevant state: orders (and their receipts), used payment signatures and
 * spend received per agent per day. With a file, every change is written before the request goes on
 * (write to a temp file, fsync, rename), and the file is loaded on start, so a restart cannot be used
 * to pay an order twice or replay a payment. A file that exists but cannot be read stops the merchant
 * from starting (fail closed). Without a file (tests, offline demo) it lives in memory.
 */
export class MerchantStore {
  readonly orders = new Map<string, Pending>();
  private readonly seen = new Map<string, string>();
  private readonly receivedMap = new Map<string, bigint>();

  constructor(private readonly file?: string) {
    if (!file || !existsSync(file)) return;
    let s: StateFile;
    try {
      s = JSON.parse(readFileSync(file, "utf8")) as StateFile;
      if (s.v !== 1 || typeof s.orders !== "object" || typeof s.seenPayments !== "object" || typeof s.received !== "object") throw new Error("unexpected format");
    } catch (e) {
      throw new Error(`merchant state ${file} is unreadable (${(e as Error).message}); refusing to start rather than forget paid orders`);
    }
    for (const [id, p] of Object.entries(s.orders)) this.orders.set(id, p);
    for (const [h, at] of Object.entries(s.seenPayments)) this.seen.set(h, at);
    for (const [k, v] of Object.entries(s.received)) this.receivedMap.set(k, BigInt(v));
  }

  hasSeenPayment(id: string): boolean {
    return this.seen.has(id);
  }

  markPaymentSeen(id: string) {
    this.seen.set(id, new Date().toISOString());
    this.save();
  }

  received(buyer: string, asset: string, now = new Date()): bigint {
    return this.receivedMap.get(`${buyer}|${utcDay(now)}|${asset}`) ?? 0n;
  }

  addReceived(buyer: string, asset: string, amount: bigint, now = new Date()) {
    const k = `${buyer}|${utcDay(now)}|${asset}`;
    this.receivedMap.set(k, (this.receivedMap.get(k) ?? 0n) + amount);
  }

  /** Persists everything (sync, atomic). Call after every change, before replying. */
  save() {
    if (!this.file) return;
    this.prune();
    const s: StateFile = {
      v: 1,
      orders: Object.fromEntries(this.orders),
      seenPayments: Object.fromEntries(this.seen),
      received: Object.fromEntries([...this.receivedMap].map(([k, v]) => [k, v.toString()])),
    };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomHex(4)}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(s));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
  }

  /** Drops what can no longer matter: expired unpaid quotes, and payment hashes and spend older than 2 days. */
  private prune() {
    const now = Date.now();
    for (const [id, p] of this.orders) if (p.state === "quoted" && p.challenge.exp * 1000 < now - 3600_000) this.orders.delete(id);
    for (const [h, at] of this.seen) if (Date.parse(at) < now - KEEP_MS) this.seen.delete(h);
    const cutoff = utcDay(new Date(now - KEEP_MS));
    for (const k of this.receivedMap.keys()) if (k.split("|")[1] < cutoff) this.receivedMap.delete(k);
  }
}
